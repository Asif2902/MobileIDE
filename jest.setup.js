/* global jest */
jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: 'GestureHandlerRootView',
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: 'SafeAreaProvider',
}));
