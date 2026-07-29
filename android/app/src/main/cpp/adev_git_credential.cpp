/*
 * Native Git credential helper for A Dev Studio.
 *
 * Git invokes: adev-git-credential <get|store|erase> and supplies protocol
 * fields on stdin. This helper talks to the app's loopback Keystore broker.
 * Stored usernames/tokens never enter React Native or a JavaScript helper.
 */

#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include <map>
#include <string>

static std::string json_escape(const std::string &value) {
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

static bool json_string(const std::string &json, const char *key, std::string *out) {
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

static std::map<std::string, std::string> read_git_input() {
    std::map<std::string, std::string> values;
    char *line = nullptr;
    size_t capacity = 0;
    while (getline(&line, &capacity, stdin) >= 0) {
        std::string item(line);
        while (!item.empty() && (item.back() == '\n' || item.back() == '\r')) {
            item.pop_back();
        }
        if (item.empty()) break;
        size_t separator = item.find('=');
        if (separator != std::string::npos && separator > 0) {
            values[item.substr(0, separator)] = item.substr(separator + 1);
        }
    }
    free(line);
    return values;
}

static bool write_all(int fd, const std::string &data) {
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

static bool broker_request(const std::string &request, std::string *response) {
    const char *port_value = getenv("ADEV_GIT_CREDENTIAL_PORT");
    if (!port_value || !port_value[0]) return false;
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
    while (output.size() <= 1024 * 1024) {
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
    if (output.size() > 1024 * 1024) return false;
    *response = output;
    return true;
}

int main(int argc, char **argv) {
    const std::string action = argc > 1 ? argv[1] : "get";
    if (action != "get" && action != "store" && action != "erase") {
        fprintf(stderr, "ADEV Git credential: unsupported operation\n");
        return 1;
    }
    const char *session = getenv("ADEV_GIT_CREDENTIAL_SESSION");
    if (!session || !session[0]) {
        fprintf(stderr, "ADEV Git credential: protected broker unavailable\n");
        return 1;
    }
    const auto values = read_git_input();
    std::string request = "{\"action\":\"" + json_escape(action) +
                          "\",\"session\":\"" + json_escape(session) + "\",\"input\":{";
    bool first = true;
    for (const auto &item : values) {
        if (!first) request += ',';
        first = false;
        request += "\"" + json_escape(item.first) + "\":\"" +
                   json_escape(item.second) + "\"";
    }
    request += "}}";

    std::string response;
    if (!broker_request(request, &response)) {
        fprintf(stderr, "ADEV Git credential: broker request failed\n");
        return 1;
    }
    if (response.find("\"ok\":true") == std::string::npos) {
        std::string error;
        if (json_string(response, "error", &error) && !error.empty()) {
            fprintf(stderr, "ADEV Git credential: %s\n", error.c_str());
        }
        return action == "get" ? 1 : 0;
    }
    if (action == "get") {
        std::string username;
        std::string password;
        if (json_string(response, "username", &username) && !username.empty()) {
            printf("username=%s\n", username.c_str());
        }
        if (json_string(response, "password", &password) && !password.empty()) {
            printf("password=%s\n", password.c_str());
        }
        printf("\n");
    }
    return 0;
}
