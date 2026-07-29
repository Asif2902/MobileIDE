const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
const path = require('path');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('metro-config').MetroConfig}
 */
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const runtimeAssets = escapeRegex(
  path.resolve(__dirname, 'android/app/src/main/assets/runtime'),
);

// Runtime CLIs are APK assets executed by the bundled Node binary; they are
// not React Native sources. Keeping the large offline pnpm/Yarn payloads out
// of Metro's graph avoids scanning/transformation work without affecting APK
// asset packaging.
const config = {
  resolver: {
    blockList: [new RegExp(`${runtimeAssets}[/\\\\].*`)],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
