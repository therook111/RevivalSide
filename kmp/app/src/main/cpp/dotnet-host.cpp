#include <dlfcn.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

using hostfxr_main_fn = int (*)(int argc, const char** argv);
using hostfxr_main_startupinfo_fn = int (*)(
    int argc,
    const char** argv,
    const char* host_path,
    const char* dotnet_root,
    const char* app_path
);

static std::string dirname_of(const char* path) {
    if (path == nullptr || path[0] == '\0') return ".";
    std::string value(path);
    const auto slash = value.find_last_of('/');
    if (slash == std::string::npos) return ".";
    if (slash == 0) return "/";
    return value.substr(0, slash);
}

static std::string join_path(const std::string& left, const char* right) {
    if (left.empty() || left == ".") return right;
    if (left.back() == '/') return left + right;
    return left + "/" + right;
}

static std::string runtime_root_for(int argc, char** argv) {
    const char* explicit_root = std::getenv("REVIVALSIDE_DOTNET_ROOT");
    if (explicit_root != nullptr && explicit_root[0] != '\0') return explicit_root;
    if (argc > 1) return dirname_of(argv[1]);
    return dirname_of(argv[0]);
}

static std::string native_root_for(char** argv) {
    const char* explicit_root = std::getenv("REVIVALSIDE_DOTNET_NATIVE_ROOT");
    if (explicit_root != nullptr && explicit_root[0] != '\0') return explicit_root;
    return dirname_of(argv[0]);
}

static void* load_hostfxr(const std::string& native_root, const std::string& runtime_root, std::string* loaded_path) {
    const std::string native_hostfxr = join_path(native_root, "libhostfxr.so");
    void* hostfxr = dlopen(native_hostfxr.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (hostfxr != nullptr) {
        if (loaded_path != nullptr) *loaded_path = native_hostfxr;
        return hostfxr;
    }

    const char* native_error = dlerror();
    const std::string runtime_hostfxr = join_path(runtime_root, "libhostfxr.so");
    hostfxr = dlopen(runtime_hostfxr.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (hostfxr != nullptr) {
        if (loaded_path != nullptr) *loaded_path = runtime_hostfxr;
        return hostfxr;
    }

    std::fprintf(
        stderr,
        "revivalside-dotnet-host: dlopen(%s) failed: %s; dlopen(%s) failed: %s\n",
        native_hostfxr.c_str(),
        native_error == nullptr ? "" : native_error,
        runtime_hostfxr.c_str(),
        dlerror()
    );
    return nullptr;
}

int main(int argc, char** argv) {
    const std::string runtime_root = runtime_root_for(argc, argv);
    const std::string native_root = native_root_for(argv);
    std::string hostfxr_path;

    setenv("DOTNET_ROOT", native_root.c_str(), 1);
    setenv("REVIVALSIDE_DOTNET_ROOT", runtime_root.c_str(), 1);
    setenv("REVIVALSIDE_DOTNET_NATIVE_ROOT", native_root.c_str(), 1);
    chdir(runtime_root.c_str());

    void* hostfxr = load_hostfxr(native_root, runtime_root, &hostfxr_path);
    if (hostfxr == nullptr) {
        return 127;
    }

    auto hostfxr_main_startupinfo = reinterpret_cast<hostfxr_main_startupinfo_fn>(
        dlsym(hostfxr, "hostfxr_main_startupinfo")
    );
    if (hostfxr_main_startupinfo != nullptr) {
        const char* app_path = argc > 1 ? argv[1] : nullptr;
        return hostfxr_main_startupinfo(argc, const_cast<const char**>(argv), argv[0], native_root.c_str(), app_path);
    }

    auto hostfxr_main = reinterpret_cast<hostfxr_main_fn>(dlsym(hostfxr, "hostfxr_main"));
    if (hostfxr_main == nullptr) {
        std::fprintf(stderr, "revivalside-dotnet-host: hostfxr_main missing: %s\n", dlerror());
        dlclose(hostfxr);
        return 127;
    }

    return hostfxr_main(argc, const_cast<const char**>(argv));
}
