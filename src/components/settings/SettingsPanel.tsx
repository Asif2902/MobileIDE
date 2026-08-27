import React from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFileStore, useRuntimeStore} from '../../stores';
import {Icon} from '../icons';
import {uiColors, uiFonts, uiRadii} from '../../theme';

const SettingRow: React.FC<{
  label: string;
  value: string;
  valueColor?: string;
}> = ({label, value, valueColor}) => (
  <View style={styles.row}>
    <Text style={styles.rowLabel}>{label}</Text>
    <Text
      style={[styles.rowValue, valueColor ? {color: valueColor} : null]}
      numberOfLines={1}
      ellipsizeMode="middle">
      {value}
    </Text>
  </View>
);

export const SettingsPanel: React.FC = () => {
  const {isReady, isInitializing, error, paths} = useRuntimeStore();
  const currentWorkspace = useFileStore(state => state.currentWorkspace);
  const runtimeState = error
    ? 'Needs attention'
    : isReady
      ? 'Ready'
      : isInitializing
        ? 'Starting'
        : 'Not initialized';
  const runtimeColor = error ? uiColors.danger : isReady ? uiColors.success : uiColors.warning;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      <View style={styles.hero}>
        <View style={styles.heroIcon}>
          <Icon name="settings" size={24} color={uiColors.accentText} />
        </View>
        <View style={styles.heroCopy}>
          <Text style={styles.title}>Settings</Text>
          <Text style={styles.subtitle}>ADEV environment and workspace overview</Text>
        </View>
      </View>

      <Text style={styles.sectionLabel}>ENVIRONMENT</Text>
      <View style={styles.card}>
        <SettingRow label="Android runtime" value={runtimeState} valueColor={runtimeColor} />
        <View style={styles.divider} />
        <SettingRow label="Workspace" value={currentWorkspace || 'No project open'} />
        <View style={styles.divider} />
        <SettingRow label="Runtime home" value={paths?.home || 'Unavailable'} />
      </View>

      <Text style={styles.sectionLabel}>DEVELOPER TOOLS</Text>
      <View style={styles.card}>
        <SettingRow label="Git and GitHub" value="Terminal / gh pack" />
        <View style={styles.divider} />
        <SettingRow label="Node toolchain" value={isReady ? 'Available' : 'Waiting for runtime'} />
        <View style={styles.divider} />
        <SettingRow label="Project storage" value="Private workspace recommended" />
      </View>

      {!!error && (
        <View style={styles.errorCard}>
          <Text style={styles.errorTitle}>Runtime issue</Text>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: uiColors.canvas,
  },
  content: {
    padding: 18,
    paddingBottom: 36,
  },
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 26,
  },
  heroIcon: {
    width: 48,
    height: 48,
    borderRadius: uiRadii.large,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: uiColors.accentSoft,
    borderWidth: 1,
    borderColor: '#382d63',
  },
  heroCopy: {
    flex: 1,
    marginLeft: 14,
  },
  title: {
    color: uiColors.text,
    fontFamily: uiFonts.medium,
    fontSize: 20,
    fontWeight: '700',
  },
  subtitle: {
    color: uiColors.textMuted,
    fontSize: 12,
    marginTop: 3,
  },
  sectionLabel: {
    color: uiColors.textMuted,
    fontFamily: uiFonts.medium,
    fontSize: 10,
    letterSpacing: 1.1,
    marginBottom: 8,
    marginLeft: 2,
  },
  card: {
    backgroundColor: uiColors.surface,
    borderRadius: uiRadii.large,
    borderWidth: 1,
    borderColor: uiColors.border,
    paddingHorizontal: 14,
    marginBottom: 22,
    overflow: 'hidden',
  },
  row: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  rowLabel: {
    color: uiColors.textSecondary,
    fontSize: 13,
  },
  rowValue: {
    flex: 1,
    color: uiColors.text,
    fontFamily: uiFonts.medium,
    fontSize: 12,
    textAlign: 'right',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: uiColors.border,
  },
  errorCard: {
    borderRadius: uiRadii.large,
    borderWidth: 1,
    borderColor: '#5b2832',
    backgroundColor: '#231419',
    padding: 14,
  },
  errorTitle: {
    color: uiColors.danger,
    fontFamily: uiFonts.medium,
    fontSize: 13,
  },
  errorText: {
    color: uiColors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 5,
  },
});

export default SettingsPanel;
