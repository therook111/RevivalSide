#include <jni.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "node.h"

extern "C" JNIEXPORT jint JNICALL
Java_dev_revivalside_capture_android_NodeMobileBridge_startNodeWithArguments(
    JNIEnv* env,
    jclass,
    jobjectArray arguments
) {
    const jsize argument_count = env->GetArrayLength(arguments);
    std::vector<std::string> argument_storage;
    argument_storage.reserve(static_cast<size_t>(argument_count));

    size_t buffer_size = 0;
    for (jsize index = 0; index < argument_count; ++index) {
        auto argument = static_cast<jstring>(env->GetObjectArrayElement(arguments, index));
        const char* value = env->GetStringUTFChars(argument, nullptr);
        argument_storage.emplace_back(value == nullptr ? "" : value);
        if (value != nullptr) {
            env->ReleaseStringUTFChars(argument, value);
        }
        env->DeleteLocalRef(argument);
        buffer_size += argument_storage.back().size() + 1;
    }

    std::vector<char> contiguous_arguments(buffer_size == 0 ? 1 : buffer_size);
    std::vector<char*> argv(static_cast<size_t>(argument_count));
    char* cursor = contiguous_arguments.data();

    for (jsize index = 0; index < argument_count; ++index) {
        const std::string& argument = argument_storage[static_cast<size_t>(index)];
        std::memcpy(cursor, argument.c_str(), argument.size());
        cursor[argument.size()] = '\0';
        argv[static_cast<size_t>(index)] = cursor;
        cursor += argument.size() + 1;
    }

    return static_cast<jint>(node::Start(static_cast<int>(argument_count), argv.data()));
}
