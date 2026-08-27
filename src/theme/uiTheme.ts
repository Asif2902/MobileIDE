import {Platform} from 'react-native';

/**
 * Shared visual language for the native IDE chrome. Code editors and terminals
 * keep their own syntax palettes, but every React Native surface should use
 * these tokens so the app reads as one product instead of stacked widgets.
 */
export const uiColors = {
  canvas: '#0b0d12',
  surface: '#11141b',
  surfaceRaised: '#171b24',
  surfacePressed: '#202534',
  border: '#252b37',
  borderStrong: '#343c4b',
  text: '#f5f7fb',
  textSecondary: '#a7afbd',
  textMuted: '#6f7888',
  accent: '#8b6cff',
  accentStrong: '#7357e8',
  accentSoft: '#211b39',
  accentText: '#c8bbff',
  success: '#45d39a',
  warning: '#f4bd50',
  danger: '#ff6b79',
  info: '#62a8ff',
  overlay: 'rgba(4, 6, 10, 0.78)',
} as const;

export const uiFonts = {
  // Inter is packaged in android/app/src/main/assets/fonts. An app-owned font
  // is required because some OEM themes remap even explicit Roboto aliases.
  regular: Platform.OS === 'android' ? 'Inter' : 'System',
  medium: Platform.OS === 'android' ? 'Inter' : 'System',
  mono: Platform.OS === 'android' ? 'monospace' : 'Menlo',
} as const;

export const uiRadii = {
  small: 7,
  medium: 10,
  large: 14,
  pill: 999,
} as const;

export const uiSpacing = {
  xsmall: 4,
  small: 8,
  medium: 12,
  large: 16,
  xlarge: 24,
} as const;
