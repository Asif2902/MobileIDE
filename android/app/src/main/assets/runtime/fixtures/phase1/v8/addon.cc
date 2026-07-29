#include <node.h>

namespace adev_fixture {
using v8::FunctionCallbackInfo;
using v8::Integer;
using v8::Local;
using v8::Object;
using v8::Value;

void Answer(const FunctionCallbackInfo<Value>& args) {
  args.GetReturnValue().Set(Integer::New(args.GetIsolate(), 42));
}

void Initialize(Local<Object> exports) {
  NODE_SET_METHOD(exports, "answer", Answer);
}

NODE_MODULE(NODE_GYP_MODULE_NAME, Initialize)
}  // namespace adev_fixture
