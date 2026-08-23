#include <arpa/inet.h>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <netinet/in.h>
#include <string>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

namespace {

constexpr size_t kMaxUrlBytes = 8 * 1024;
constexpr size_t kMaxResponseBytes = 12 * 1024;
constexpr size_t kMaxCapabilityBytes = 4 * 1024;
constexpr const char* kCapabilityHeader = "adev-url-opener-v1";
constexpr const char* kCapabilitySuffix = "/runtime/home/.adev-url-opener-v1";

std::string json_escape(const char* value) {
    std::string output;
    for (const unsigned char* cursor = reinterpret_cast<const unsigned char*>(value);
         *cursor != '\0'; ++cursor) {
        const unsigned char ch = *cursor;
        switch (ch) {
            case '\"': output += "\\\""; break;
            case '\\': output += "\\\\"; break;
            case '\b': output += "\\b"; break;
            case '\f': output += "\\f"; break;
            case '\n': output += "\\n"; break;
            case '\r': output += "\\r"; break;
            case '\t': output += "\\t"; break;
            default:
                if (ch < 0x20 || ch == 0x7f) {
                    char escaped[7] = {};
                    std::snprintf(escaped, sizeof(escaped), "\\u%04x", ch);
                    output += escaped;
                } else {
                    output.push_back(static_cast<char>(ch));
                }
        }
    }
    return output;
}

bool write_all(int descriptor, const std::string& payload) {
    size_t written = 0;
    while (written < payload.size()) {
        const ssize_t result = send(
            descriptor, payload.data() + written, payload.size() - written, MSG_NOSIGNAL
        );
        if (result < 0 && errno == EINTR) continue;
        if (result <= 0) return false;
        written += static_cast<size_t>(result);
    }
    return true;
}

int unavailable(const char* message) {
    std::fprintf(stderr, "xdg-open: %s\n", message);
    return 69;
}

bool read_capability(
    const char* path,
    std::string* port,
    std::string* session
) {
    if (path == nullptr || path[0] != '/' || port == nullptr || session == nullptr) {
        errno = EINVAL;
        return false;
    }
    const size_t path_length = std::strlen(path);
    const size_t suffix_length = std::strlen(kCapabilitySuffix);
    if (path_length <= suffix_length ||
        std::strcmp(path + path_length - suffix_length, kCapabilitySuffix) != 0) {
        errno = EACCES;
        return false;
    }
    const int descriptor = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (descriptor < 0) return false;
    struct stat metadata {};
    if (fstat(descriptor, &metadata) != 0 || !S_ISREG(metadata.st_mode) ||
        metadata.st_uid != geteuid() || metadata.st_nlink != 1 ||
        (metadata.st_mode & (S_IRWXG | S_IRWXO)) != 0 ||
        metadata.st_size <= 0 || metadata.st_size > static_cast<off_t>(kMaxCapabilityBytes)) {
        close(descriptor);
        errno = EACCES;
        return false;
    }
    std::string payload(static_cast<size_t>(metadata.st_size), '\0');
    size_t offset = 0;
    while (offset < payload.size()) {
        const ssize_t count = read(descriptor, payload.data() + offset, payload.size() - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) break;
        offset += static_cast<size_t>(count);
    }
    close(descriptor);
    if (offset != payload.size()) return false;

    const size_t first = payload.find('\n');
    const size_t second = first == std::string::npos ? first : payload.find('\n', first + 1);
    const size_t third = second == std::string::npos ? second : payload.find('\n', second + 1);
    if (first == std::string::npos || second == std::string::npos ||
        third == std::string::npos || third != payload.size() - 1 ||
        payload.find('\0') != std::string::npos ||
        payload.substr(0, first) != kCapabilityHeader) {
        errno = EINVAL;
        return false;
    }
    *port = payload.substr(first + 1, second - first - 1);
    *session = payload.substr(second + 1, third - second - 1);
    if (port->empty() || session->size() != 44 || session->back() != '=') return false;
    for (size_t index = 0; index + 1 < session->size(); ++index) {
        const unsigned char ch = static_cast<unsigned char>((*session)[index]);
        if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
              (ch >= '0' && ch <= '9') || ch == '-' || ch == '_')) {
            return false;
        }
    }
    return true;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc == 2 && (std::strcmp(argv[1], "--help") == 0 || std::strcmp(argv[1], "-h") == 0)) {
        std::puts("usage: xdg-open [--capability-file <private-file>] <http-or-https-url>");
        return 0;
    }
    const bool uses_capability_file = argc == 4 && std::strcmp(argv[1], "--capability-file") == 0;
    const char* url = uses_capability_file ? argv[3] : (argc == 2 ? argv[1] : nullptr);
    if (url == nullptr || url[0] == '\0' || std::strlen(url) > kMaxUrlBytes) {
        std::fprintf(stderr, "usage: xdg-open [--capability-file <private-file>] <http-or-https-url>\n");
        return 64;
    }

    std::string port_storage;
    std::string session_storage;
    if (uses_capability_file &&
        !read_capability(argv[2], &port_storage, &session_storage)) {
        return unavailable("the private Android URL broker capability is invalid");
    }
    const char* port_value = uses_capability_file
        ? port_storage.c_str()
        : std::getenv("ADEV_URL_OPENER_PORT");
    const char* session = uses_capability_file
        ? session_storage.c_str()
        : std::getenv("ADEV_URL_OPENER_SESSION");
    if (port_value == nullptr || session == nullptr || session[0] == '\0') {
        return unavailable("the authenticated Android URL broker is unavailable");
    }
    char* port_end = nullptr;
    const long port = std::strtol(port_value, &port_end, 10);
    if (port_end == port_value || *port_end != '\0' || port <= 0 || port > 65535) {
        return unavailable("the Android URL broker port is invalid");
    }

    const int descriptor = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (descriptor < 0) return unavailable("cannot create a broker socket");
    timeval timeout {.tv_sec = 5, .tv_usec = 0};
    setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));

    sockaddr_in address {};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<uint16_t>(port));
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(descriptor, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) {
        close(descriptor);
        return unavailable("cannot connect to the Android URL broker");
    }

    const std::string request =
        "{\"version\":1,\"session\":\"" + json_escape(session) +
        "\",\"action\":\"view\",\"url\":\"" + json_escape(url) + "\"}\n";
    if (!write_all(descriptor, request)) {
        close(descriptor);
        return unavailable("cannot send the URL request");
    }
    shutdown(descriptor, SHUT_WR);

    std::string response;
    char buffer[1024];
    while (response.size() <= kMaxResponseBytes) {
        const ssize_t count = recv(descriptor, buffer, sizeof(buffer), 0);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) break;
        response.append(buffer, static_cast<size_t>(count));
        if (response.find('\n') != std::string::npos) break;
    }
    close(descriptor);

    if (response.size() > kMaxResponseBytes) {
        return unavailable("the Android URL broker response was too large");
    }
    if (response.find("\"ok\":true") != std::string::npos) return 0;
    std::fprintf(stderr, "xdg-open: Android rejected the URL request\n");
    return 1;
}
