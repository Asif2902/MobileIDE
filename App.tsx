import React, { useState } from 'react';
import {Text, TextInput, TextStyle} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { IDEScreen } from './src/screens/IDEScreen';
import { SplashScreen } from './src/components/SplashScreen';
import {uiFonts} from './src/theme';

// Some Android vendors replace the system UI typeface with decorative fonts.
// An IDE must stay readable regardless of that device setting. Explicit local
// styles (for example the terminal monospace face) still override this default.
type TextWithDefaults = typeof Text & {
  defaultProps?: {style?: TextStyle | TextStyle[]};
};
type TextInputWithDefaults = typeof TextInput & {
  defaultProps?: {style?: TextStyle | TextStyle[]};
};
const DefaultText = Text as TextWithDefaults;
const DefaultTextInput = TextInput as TextInputWithDefaults;
DefaultText.defaultProps = {
  ...DefaultText.defaultProps,
  style: [{fontFamily: uiFonts.regular}, DefaultText.defaultProps?.style].filter(Boolean) as TextStyle[],
};
DefaultTextInput.defaultProps = {
  ...DefaultTextInput.defaultProps,
  style: [{fontFamily: uiFonts.regular}, DefaultTextInput.defaultProps?.style].filter(Boolean) as TextStyle[],
};

const App: React.FC = () => {
  const [showSplash, setShowSplash] = useState(true);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {showSplash ? (
          <SplashScreen onFinish={() => setShowSplash(false)} />
        ) : (
          <IDEScreen />
        )}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
};

export default App;
