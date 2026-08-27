import React, { useEffect, useRef } from 'react';
import {
  View,
  Animated,
  Easing,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';

interface SplashScreenProps {
  /** Called once the fill animation completes. */
  onFinish?: () => void;
  /** Total duration of the fill animation in ms. */
  duration?: number;
}

const loadingImage = require('../assets/loading.jpg');

/**
 * Animated launch screen: the ADEV Studio logo fades/scales in while a
 * progress bar "fills" from 0 -> 100%, then hands off to the IDE.
 */
export const SplashScreen: React.FC<SplashScreenProps> = ({
  onFinish,
  duration = 650,
}) => {
  const { width } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const logoOpacity = useRef(new Animated.Value(0)).current;
  const logoScale = useRef(new Animated.Value(0.86)).current;

  // Logo is a large square asset; size it responsively.
  const logoSize = Math.min(width * 0.6, 260);
  const barWidth = Math.min(width * 0.62, 280);

  useEffect(() => {
    const animation = Animated.sequence([
      Animated.parallel([
        Animated.timing(logoOpacity, {
          toValue: 1,
        duration: 220,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.spring(logoScale, {
          toValue: 1,
          friction: 6,
          tension: 60,
          useNativeDriver: true,
        }),
      ]),
      Animated.timing(progress, {
        toValue: 1,
        duration,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]);

    animation.start(({ finished }) => {
      if (finished && onFinish) {
        onFinish();
      }
    });

    return () => animation.stop();
  }, [duration, logoOpacity, logoScale, progress, onFinish]);

  const fillTranslateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-barWidth, 0],
  });

  return (
    <View style={styles.container}>
      <Animated.Image
        source={loadingImage}
        resizeMode="contain"
        style={[
          styles.logo,
          {
            width: logoSize,
            height: logoSize,
            opacity: logoOpacity,
            transform: [{ scale: logoScale }],
          },
        ]}
      />

      <View style={[styles.track, { width: barWidth }]}>
        <Animated.View
          style={[
            styles.fill,
            {width: barWidth, transform: [{translateX: fillTranslateX}]},
          ]}
        />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: '#0a0a0a',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
    elevation: 20,
  },
  logo: {
    marginBottom: 44,
  },
  track: {
    height: 5,
    borderRadius: 3,
    backgroundColor: '#1f1f24',
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: '#8b5cf6',
  },
});

export default SplashScreen;
