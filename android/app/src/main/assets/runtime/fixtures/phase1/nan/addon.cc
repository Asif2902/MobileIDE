#include <nan.h>

NAN_METHOD(Answer) {
  info.GetReturnValue().Set(Nan::New(42));
}

NAN_MODULE_INIT(Initialize) {
  Nan::Set(target, Nan::New("answer").ToLocalChecked(),
           Nan::GetFunction(Nan::New<v8::FunctionTemplate>(Answer)).ToLocalChecked());
}

NODE_MODULE(adev_fixture_nan, Initialize)
