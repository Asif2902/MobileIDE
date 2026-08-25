/*
 * Generic secure secret CLI for A Dev Studio (`adev-secret`).
 *
 * Any CLI tool — GitHub CLI wrappers, Codex/Grok agents, user scripts — can
 * persist and retrieve credentials through the app's AndroidKeyStore-backed
 * vault without secrets ever appearing in argv, shell history, or world
 * readable files:
 *
 *   printf '%s' "$TOKEN" | adev-secret set gh:token
 *   export GH_TOKEN="$(adev-secret get gh:token)"
 *   adev-secret list
 *   adev-secret delete gh:token
 *
 * The CLI is a thin client of the authenticated loopback broker inside the
 * app process; encryption never leaves the app sandbox.
 */

#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include <string>

namespace {

constexpr size_t kMaxKeyChars = 128;
constexpr size_t kMaxValueBytes = 64 * 1024;
constexpr size_t kMaxResponseBytes = 1024 * 1024;

bool valid_key(const std::string &key) {
    if (key.empty() || key.size() > kMaxKeyChars) return false;
    for (unsigned char c : key) {
        const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || c == '.' || c == '_' || c == ':' ||
            c == '@' || c == '-' || c == '/';
        if (!ok) return false;
    }
    return true;
}

std::string json_escape(const std::string &value) {
    std::string out;
    out.reserve(value.size() + 16);
    for (unsigned char c : value) {
        switch (c) {
            case '\\': out += "\\\\"; break;
            case '"': out += "\\\""; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char encoded[7];
                    snprintf(encoded, sizeof(encoded), "\\u%04x", c);
                    out += encoded;
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    return out;
}

static int hex_value(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static void append_utf8(std::string &out, unsigned codepoint) {
    if (codepoint <= 0x7f) {
        out += static_cast<char>(codepoint);
    } else if (codepoint <= 0x7ff) {
        out += static_cast<char>(0xc0 | (codepoint >> 6));
        out += static_cast<char>(0x80 | (codepoint & 0x3f));
    } else {
        out += static_cast<char>(0xe0 | (codepoint >> 12));
        out += static_cast<char>(0x80 | ((codepoint >> 6) & 0x3f));
        out += static_cast<char>(0x80 | (codepoint & 0x3f));
    }
}

bool json_string(const std::string &json, const char *key, std::string *out) {
    const std::string needle = std::string("\"") + key + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) return false;
    pos = json.find(':', pos + needle.size());
    if (pos == std::string::npos) return false;
    pos = json.find('"', pos + 1);
    if (pos == std::string::npos) return false;
    pos++;
    std::string decoded;
    while (pos < json.size()) {
        char c = json[pos++];
        if (c == '"') {
            *out = decoded;
            return true;
        }
        if (c != '\\') {
            decoded += c;
            continue;
        }
        if (pos >= json.size()) return false;
        char escaped = json[pos++];
        switch (escaped) {
            case '"': decoded += '"'; break;
            case '\\': decoded += '\\'; break;
            case '/': decoded += '/'; break;
            case 'b': decoded += '\b'; break;
            case 'f': decoded += '\f'; break;
            case 'n': decoded += '\n'; break;
            case 'r': decoded += '\r'; break;
            case 't': decoded += '\t'; break;
            case 'u': {
                if (pos + 4 > json.size()) return false;
                unsigned codepoint = 0;
                for (int i = 0; i < 4; i++) {
                    int value = hex_value(json[pos++]);
                    if (value < 0) return false;
                    codepoint = (codepoint << 4) | static_cast<unsigned>(value);
                }
                append_utf8(decoded, codepoint);
                break;
            }
            default: return false;
        }
    }
    return false;
}

std::string read_all_stdin() {
    std::string value;
    char buffer[4096];
    size_t total = 0;
    for (;;) {
        ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
        if (count == 0) break;
        if (count < 0) {
            if (errno == EINTR) continue;
            break;
        }
        total += static_cast<size_t>(count);
        if (total > kMaxValueBytes) return {};
        value.append(buffer, static_cast<size_t>(count));
    }
    return value;
}

bool write_all(int fd, const std::string &data) {
    size_t offset = 0;
    while (offset < data.size()) {
        ssize_t written = write(fd, data.data() + offset, data.size() - offset);
        if (written < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        offset += static_cast<size_t>(written);
    }
    return true;
}

bool broker_request(const std::string &request, std::string *response) {
    const char *port_value = getenv("ADEV_GIT_CREDENTIAL_PORT");
    const char *session = getenv("ADEV_GIT_CREDENTIAL_SESSION");
    if (!port_value || !port_value[0] || !session || !session[0]) return false;
    char *end = nullptr;
    long port = strtol(port_value, &end, 10);
    if (!end || *end || port <= 0 || port > 65535) return false;

    int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) return false;
    struct timeval timeout = {15, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    struct sockaddr_in address = {};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<uint16_t>(port));
    inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
    if (connect(fd, reinterpret_cast<struct sockaddr *>(&address), sizeof(address)) != 0) {
        close(fd);
        return false;
    }
    if (!write_all(fd, request + "\n")) {
        close(fd);
        return false;
    }
    shutdown(fd, SHUT_WR);
    std::string output;
    char buffer[4096];
    while (output.size() <= kMaxResponseBytes) {
        ssize_t count = read(fd, buffer, sizeof(buffer));
        if (count == 0) break;
        if (count < 0) {
            if (errno == EINTR) continue;
            close(fd);
            return false;
        }
        output.append(buffer, static_cast<size_t>(count));
    }
    close(fd);
    if (output.size() > kMaxResponseBytes) return false;
    *response = output;
    return true;
}

int fail(const char *message) {
    fprintf(stderr, "adev-secret: %s\n", message);
    return 1;
}

}  // namespace

int main(int argc, char **argv) {
    const std::string action = argc > 1 ? argv[1] : "";
    const bool needs_key = action == "get" || action == "set" || action == "delete";
    if ((needs_key && argc != 3) || (!needs_key && (action != "list" || argc != 2))) {
        fprintf(stderr,
                "usage: adev-secret <get|set|delete> <key>\n"
                "       adev-secret list\n"
                "secret values for `set` are read from standard input\n");
        return 64;
    }

    std::string request_action;
    std::string body;
    if (action == "list") {
        request_action = "secret-list";
    } else {
        const std::string key = argv[2];
        if (!valid_key(key)) return fail("invalid secret key");
        request_action = "secret-" + action;
        body = "\"key\":\"" + json_escape(key) + "\"";
        if (action == "set") {
            // The value travels over stdin/loopback only — never argv, so it
            // cannot leak into shell history or process listings.
            const std::string value = read_all_stdin();
            if (value.empty()) return fail("empty secret value on standard input");
            body += ",\"value\":\"" + json_escape(value) + "\"";
        }
    }

    const char *session = getenv("ADEV_GIT_CREDENTIAL_SESSION");
    if (!session || !session[0]) return fail("protected broker unavailable");
    std::string request = "{\"action\":\"" + request_action +
                          "\",\"session\":\"" + json_escape(session) +
                          "\",\"input\":{" + body + "}}";

    std::string response;
    if (!broker_request(request, &response)) return fail("broker request failed");
    if (response.find("\"ok\":true") == std::string::npos) {
        std::string error;
        if (json_string(response, "error", &error) && !error.empty()) {
            return fail(error.c_str());
        }
        return action == "get" ? fail("secret not found") : fail("broker rejected the request");
    }
    if (action == "get") {
        std::string value;
        if (!json_string(response, "value", &value)) return fail("secret not found");
        printf("%s\n", value.c_str());
    } else if (action == "list") {
        // {"ok":true,"keys":["a","b"]} — keys are validated to a restricted
        // charset on write, so this direct scan of the array is exact; only
        // the JSON "/" escape needs undoing for display.
        size_t cursor = response.find("\"keys\":[");
        if (cursor != std::string::npos) {
            cursor += strlen("\"keys\":[");
            while (cursor < response.size() && response[cursor] != ']') {
                if (response[cursor] != '"') break;
                const size_t end = response.find('"', cursor + 1);
                if (end == std::string::npos) break;
                std::string key =
                    response.substr(cursor + 1, end - cursor - 1);
                size_t slash = key.find("\\/");
                while (slash != std::string::npos) {
                    key.replace(slash, 2, "/");
                    slash = key.find("\\/", slash + 1);
                }
                printf("%s\n", key.c_str());
                cursor = end + 1;
                if (cursor < response.size() && response[cursor] == ',') cursor++;
            }
        }
    }
    return 0;
}
