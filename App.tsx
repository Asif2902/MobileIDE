import React, { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { IDEScreen } from './src/screens/IDEScreen';
import { SplashScreen } from './src/components/SplashScreen';

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
