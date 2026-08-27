import React, { useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Icon, IconName } from '../icons';
import {uiColors, uiFonts, uiRadii} from '../../theme';

export interface TerminalAccessoryBarProps {
  /** Send a fully-formed byte sequence (arrows, F-keys, symbols, …) to the PTY. */
  onKey: (seq: string) => void;
  /** Arm/disarm the Ctrl modifier for the next typed character. */
  onCtrl: () => void;
  /** Arm/disarm the Alt/Meta modifier for the next typed character. */
  onAlt: () => void;
  /** Copy the current selection (or whole buffer) to the clipboard. */
  onCopy: () => void;
  /** Paste the clipboard into the terminal. */
  onPaste: () => void;
  /** Open touch selection sheet for finger text selection */
  onSelectText?: () => void;
  /** Scale font size smaller */
  onFontSmaller?: () => void;
  /** Scale font size larger */
  onFontLarger?: () => void;
  /** Current persisted terminal font size. */
  fontSize?: number;
  /** Clear only the visible xterm screen, preserving history and the PTY. */
  onClearScreen?: () => void;
  /** Clear the visible screen and all local scrollback, preserving the PTY. */
  onClearScrollback?: () => void;
  ctrlArmed: boolean;
  altArmed: boolean;
}

interface KeyDef {
  label: string;
  seq: string;
  icon?: IconName;
}

// Essential keys that Android soft keyboards lack. Sequences are the raw bytes
// a VT100/xterm terminal expects.
const PRIMARY_KEYS: KeyDef[] = [
  { label: 'ESC', seq: '\x1b' },
  { label: 'TAB', seq: '\t' },
  { label: '/', seq: '/' },
  { label: '-', seq: '-' },
  { label: 'HOME', seq: '\x1b[H' },
  { label: 'END', seq: '\x1b[F' },
  { label: 'Up', seq: '\x1b[A', icon: 'arrow-up' },
  { label: 'Down', seq: '\x1b[B', icon: 'arrow-down' },
  { label: 'Left', seq: '\x1b[D', icon: 'arrow-left' },
  { label: 'Right', seq: '\x1b[C', icon: 'arrow-right' },
  { label: 'PGUP', seq: '\x1b[5~' },
  { label: 'PGDN', seq: '\x1b[6~' },
  { label: 'DEL', seq: '\x1b[3~' },
];

// F-keys and common shell symbols, revealed by the "Fn" toggle.
const FN_KEYS: KeyDef[] = [
  { label: 'F1', seq: '\x1bOP' },
  { label: 'F2', seq: '\x1bOQ' },
  { label: 'F3', seq: '\x1bOR' },
  { label: 'F4', seq: '\x1bOS' },
  { label: 'F5', seq: '\x1b[15~' },
  { label: 'F6', seq: '\x1b[17~' },
  { label: 'F7', seq: '\x1b[18~' },
  { label: 'F8', seq: '\x1b[19~' },
  { label: 'F9', seq: '\x1b[20~' },
  { label: 'F10', seq: '\x1b[21~' },
  { label: 'F11', seq: '\x1b[23~' },
  { label: 'F12', seq: '\x1b[24~' },
  { label: '|', seq: '|' },
  { label: '~', seq: '~' },
  { label: '\\', seq: '\\' },
  { label: '^', seq: '^' },
  { label: '$', seq: '$' },
  { label: '*', seq: '*' },
  { label: '&', seq: '&' },
  { label: '=', seq: '=' },
  { label: '+', seq: '+' },
  { label: '#', seq: '#' },
  { label: '%', seq: '%' },
  { label: '{', seq: '{' },
  { label: '}', seq: '}' },
  { label: '[', seq: '[' },
  { label: ']', seq: ']' },
  { label: '<', seq: '<' },
  { label: '>', seq: '>' },
];

const KeyButton: React.FC<{
  label: string;
  onPress: () => void;
  active?: boolean;
  wide?: boolean;
  icon?: IconName;
  accessibilityLabel?: string;
}> = ({ label, onPress, active, wide, icon, accessibilityLabel }) => (
  <TouchableOpacity
    style={[styles.key, wide && styles.keyWide, active && styles.keyActive]}
    onPress={onPress}
    activeOpacity={0.6}
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel || `${label} terminal key`}
  >
    {icon ? (
      <Icon
        name={icon}
        size={17}
        strokeWidth={2.2}
        color={active ? uiColors.text : uiColors.textSecondary}
      />
    ) : (
      <Text style={[styles.keyText, active && styles.keyTextActive]} numberOfLines={1}>
        {label}
      </Text>
    )}
  </TouchableOpacity>
);

export const TerminalAccessoryBar: React.FC<TerminalAccessoryBarProps> = ({
  onKey,
  onCtrl,
  onAlt,
  onCopy,
  onPaste,
  onSelectText,
  onFontSmaller,
  onFontLarger,
  fontSize,
  onClearScreen,
  onClearScrollback,
  ctrlArmed,
  altArmed,
}) => {
  const [showFn, setShowFn] = useState(false);

  return (
    <View style={styles.container}>
      {showFn && (
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.row}
        >
          {FN_KEYS.map(k => (
            <KeyButton key={k.label} label={k.label} onPress={() => onKey(k.seq)} />
          ))}
        </ScrollView>
      )}
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        <KeyButton label="CTRL" onPress={onCtrl} active={ctrlArmed} wide />
        <KeyButton label="ALT" onPress={onAlt} active={altArmed} wide />
        {PRIMARY_KEYS.map(k => (
          <KeyButton key={k.label} label={k.label} icon={k.icon} onPress={() => onKey(k.seq)} />
        ))}
        <KeyButton label="Fn" onPress={() => setShowFn(v => !v)} active={showFn} wide />
        {onSelectText && <KeyButton label="SELECT" onPress={onSelectText} wide />}
        {onFontSmaller && <KeyButton label="A-" onPress={onFontSmaller} />}
        {typeof fontSize === 'number' && (
          <View style={styles.fontSizeBadge} accessibilityLabel={`Terminal font size ${fontSize}`}>
            <Text style={styles.fontSizeText}>{fontSize}</Text>
          </View>
        )}
        {onFontLarger && <KeyButton label="A+" onPress={onFontLarger} />}
        {onClearScreen && (
          <KeyButton
            label="SCREEN"
            onPress={onClearScreen}
            wide
            accessibilityLabel="Clear visible terminal screen"
          />
        )}
        {onClearScrollback && (
          <KeyButton
            label="HISTORY"
            onPress={onClearScrollback}
            wide
            accessibilityLabel="Clear all terminal scrollback"
          />
        )}
        <TouchableOpacity
          style={[styles.key, styles.keyWide]}
          onPress={onCopy}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="Copy terminal selection"
        >
          <Icon name="copy" size={15} color={uiColors.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.key, styles.keyWide]}
          onPress={onPaste}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="Paste into terminal"
        >
          <Text style={styles.keyText}>PASTE</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: uiColors.surface,
    borderTopWidth: 1,
    borderTopColor: uiColors.border,
    paddingVertical: 5,
  },
  row: {
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  key: {
    minWidth: 32,
    height: 34,
    paddingHorizontal: 8,
    marginHorizontal: 2,
    borderRadius: uiRadii.small,
    backgroundColor: uiColors.surfacePressed,
    borderWidth: 1,
    borderColor: uiColors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyWide: {
    minWidth: 48,
  },
  keyActive: {
    backgroundColor: uiColors.accent,
    borderColor: uiColors.accent,
  },
  keyText: {
    color: uiColors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    fontFamily: uiFonts.mono,
  },
  keyTextActive: {
    color: uiColors.text,
  },
  fontSizeBadge: {
    minWidth: 24,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fontSizeText: {
    color: uiColors.textMuted,
    fontSize: 11,
    fontFamily: uiFonts.mono,
  },
});

export default TerminalAccessoryBar;
