import React, { useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useEditorStore } from '../../stores';
import { useProcessStore } from '../../stores/processStore';
import { MobileIDENativeModule } from '../../native';
import { Icon } from '../icons';
import {uiColors, uiFonts, uiRadii} from '../../theme';

export const ProblemsView: React.FC = () => {
  const { diagnostics, revealLocation } = useEditorStore();

  const allProblems: Array<{
    filePath: string;
    fileName: string;
    severity: 'error' | 'warning' | 'info' | 'hint';
    message: string;
    line: number;
    column: number;
  }> = [];

  Object.entries(diagnostics).forEach(([filePath, diag]) => {
    const fileName = filePath.split('/').pop() || filePath;
    diag.problems.forEach(p => {
      allProblems.push({
        filePath,
        fileName,
        severity: p.severity,
        message: p.message,
        line: p.startLine,
        column: p.startColumn,
      });
    });
  });

  if (allProblems.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Icon name="problems" size={32} color="#6a9955" />
        <Text style={styles.emptyTitle}>No problems detected in workspace</Text>
        <Text style={styles.emptyHint}>
          Syntax diagnostics appear when the editor language service reports them.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      {allProblems.map((prob, index) => (
        <TouchableOpacity
          key={`${prob.filePath}-${prob.line}-${prob.column}-${index}`}
          style={styles.problemItem}
          onPress={() => {
            revealLocation(prob.filePath, prob.line, prob.column).catch(error =>
              Alert.alert('Could not open problem', error?.message || String(error)),
            );
          }}
        >
          <Icon
            name={prob.severity === 'error' ? 'close' : 'problems'}
            size={14}
            color={prob.severity === 'error' ? '#f44747' : '#cca700'}
          />
          <View style={styles.problemTextContainer}>
            <Text style={styles.problemMessage} numberOfLines={2}>
              {prob.message}
            </Text>
            <Text style={styles.problemLocation}>
              {prob.fileName} [{prob.line}, {prob.column}]
            </Text>
          </View>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
};

/**
 * Output panel — shows background process logs and open ports from ProcessNative.
 * Dev servers / builds spawned via ProcessNative stream here.
 */
export const OutputView: React.FC = () => {
  const { processes, ports, logs, isLoading, error, refresh, kill, restart, clearLogs } =
    useProcessStore();

  useEffect(() => {
    refresh();
    const t = setInterval(() => {
      refresh();
    }, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  // An interactive terminal shell is infrastructure, not a development
  // server. Show background tasks plus terminal-owned tasks once a verified
  // listening port proves that they are serving something.
  const managedTasks = processes.filter(
    task =>
      task.isRunning &&
      (task.source === 'BACKGROUND' ||
        task.ports.length > 0 ||
        ports.some(port => port.taskId === task.id)),
  );

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Text style={styles.toolbarTitle}>Run & preview</Text>
        <View style={styles.toolbarActions}>
          <TouchableOpacity style={styles.toolBtn} onPress={() => refresh()}>
            <Text style={styles.toolBtnText}>Refresh</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.toolBtn} onPress={() => clearLogs()}>
            <Text style={styles.toolBtnText}>Clear</Text>
          </TouchableOpacity>
        </View>
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Development processes{isLoading ? ' …' : ''}</Text>
        {managedTasks.length === 0 ? (
          <View style={styles.outputEmpty}>
            <Icon name="output" size={30} color="#52525b" />
            <Text style={styles.outputEmptyTitle}>No running development servers</Text>
            <Text style={styles.outputEmptyHint}>
              Start a project command in Terminal. Verified ports and controls will appear here.
            </Text>
          </View>
        ) : (
          managedTasks.map(task => {
            const taskPorts = ports.filter(port => port.taskId === task.id);
            return (
              <View key={task.id} style={styles.serverCard}>
                <View style={styles.serverHeader}>
                  <View style={styles.runningDot} />
                  <Text style={styles.procCmd} numberOfLines={1}>
                    {task.command}
                  </Text>
                  <Text style={styles.taskType}>{task.type}</Text>
                </View>
                <Text style={styles.taskMeta} numberOfLines={1} ellipsizeMode="middle">
                  PID {task.pid} · group {task.processGroupId} · {task.cwd}
                </Text>
                <View style={styles.serverActions}>
                  {taskPorts.map(port => (
                    <TouchableOpacity
                      key={`${task.id}-${port.port}`}
                      style={styles.openBtn}
                      onPress={() => {
                        MobileIDENativeModule.openUrl(port.url).catch(e =>
                          Alert.alert('Open failed', e?.message || String(e)),
                        );
                      }}
                    >
                      <Text style={styles.openBtnText}>Open :{port.port}</Text>
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity style={styles.secondaryBtn} onPress={() => restart(task)}>
                    <Text style={styles.secondaryBtnText}>Restart</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.stopBtn} onPress={() => kill(task.id)}>
                    <Text style={styles.stopBtnText}>Stop</Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          })
        )}
      </View>

      <View style={[styles.section, styles.logSection]}>
        <Text style={styles.sectionTitle}>Log</Text>
        <ScrollView style={styles.logBox}>
          {logs.length === 0 ? (
            <Text style={styles.muted}>
              Process stdout/stderr appears here. Terminal I/O stays in the Terminal tab.
            </Text>
          ) : (
            logs.map((line, i) => (
              <Text
                key={`${line.at}-${i}`}
                style={[
                  styles.logText,
                  line.stream === 'stderr' && styles.logErr,
                  line.stream === 'system' && styles.logSys,
                ]}
              >
                {line.stream === 'system' ? '' : `[${line.processId}] `}
                {line.data}
              </Text>
            ))
          )}
          {isLoading && logs.length === 0 ? (
            <ActivityIndicator size="small" color="#8b5cf6" style={styles.loadingIndicator} />
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
};

export const DebugView: React.FC = () => {
  const { ports, processes } = useProcessStore();
  useEffect(() => {
    const refresh = useProcessStore.getState().refresh;
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, []);

  const running = processes.filter(task => task.isRunning);

  return (
    <View style={styles.container}>
      <ScrollView style={styles.logBox}>
        <Text style={styles.sectionTitle}>Runtime process snapshot</Text>
        <Text style={styles.snapshotNotice}>
          Process inspection only — no source-level debugger is attached.
        </Text>
        {running.length === 0 ? (
          <Text style={styles.outputEmptyHint}>No active processes.</Text>
        ) : (
          running.map(task => {
            const taskPorts = ports.filter(port => port.taskId === task.id);
            return (
              <View key={task.id} style={styles.snapshotCard}>
                <Text style={styles.procCmd} selectable>
                  {task.command}
                </Text>
                <Text style={styles.taskMeta} selectable>
                  task {task.id} · PID {task.pid} · group {task.processGroupId}
                </Text>
                <Text style={styles.taskMeta} selectable>
                  {task.type.toLowerCase()} · {task.source.toLowerCase()} · {task.state.toLowerCase()}
                </Text>
                <Text style={styles.taskMeta} selectable numberOfLines={2}>
                  cwd: {task.cwd}
                </Text>
                <Text style={styles.taskMeta} selectable>
                  ports: {taskPorts.map(port => port.port).join(', ') || 'none'}
                </Text>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: uiColors.canvas,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  emptyTitle: {
    color: uiColors.textSecondary,
    fontFamily: uiFonts.medium,
    fontSize: 13,
    marginTop: 10,
  },
  emptyHint: {
    color: uiColors.textMuted,
    fontSize: 11,
    marginTop: 6,
    textAlign: 'center',
  },
  problemItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: uiColors.border,
  },
  problemTextContainer: {
    marginLeft: 8,
    flex: 1,
  },
  problemMessage: {
    color: uiColors.textSecondary,
    fontSize: 12,
  },
  problemLocation: {
    color: uiColors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: uiColors.border,
  },
  toolbarTitle: {
    color: uiColors.text,
    fontFamily: uiFonts.medium,
    fontSize: 12,
    fontWeight: '600',
  },
  toolbarActions: {
    flexDirection: 'row',
  },
  toolBtn: {
    marginLeft: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: uiColors.surfaceRaised,
    borderRadius: uiRadii.small,
  },
  toolBtnText: {
    color: uiColors.accentText,
    fontSize: 11,
  },
  section: {
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  logSection: {
    flex: 1,
  },
  loadingIndicator: {
    marginTop: 8,
  },
  sectionTitle: {
    color: uiColors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  outputEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 150,
    paddingHorizontal: 28,
  },
  outputEmptyTitle: {
    color: uiColors.text,
    fontFamily: uiFonts.medium,
    fontSize: 14,
    fontWeight: '600',
    marginTop: 10,
  },
  outputEmptyHint: {
    color: uiColors.textMuted,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 5,
    textAlign: 'center',
  },
  serverCard: {
    backgroundColor: uiColors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: uiColors.border,
    borderRadius: uiRadii.medium,
    padding: 10,
    marginBottom: 8,
  },
  serverHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  runningDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#22c55e',
    marginRight: 7,
  },
  procCmd: {
    color: uiColors.text,
    fontSize: 12,
    fontFamily: uiFonts.mono,
    flex: 1,
  },
  taskType: {
    color: uiColors.accentText,
    fontSize: 9,
    fontWeight: '700',
    marginLeft: 8,
  },
  taskMeta: {
    color: uiColors.textMuted,
    fontSize: 11,
    fontFamily: uiFonts.mono,
    lineHeight: 16,
    marginTop: 4,
  },
  serverActions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 9,
  },
  openBtn: {
    backgroundColor: uiColors.accent,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 4,
  },
  openBtnText: {
    color: uiColors.text,
    fontFamily: uiFonts.medium,
    fontSize: 11,
    fontWeight: '600',
  },
  secondaryBtn: {
    backgroundColor: uiColors.surfacePressed,
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 4,
  },
  secondaryBtnText: {
    color: uiColors.textSecondary,
    fontSize: 11,
    fontWeight: '600',
  },
  stopBtn: {
    backgroundColor: '#451a1a',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#7f1d1d',
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 4,
  },
  stopBtnText: {
    color: '#fca5a5',
    fontSize: 11,
    fontWeight: '600',
  },
  snapshotNotice: {
    color: uiColors.textSecondary,
    fontSize: 11,
    lineHeight: 16,
    marginBottom: 10,
  },
  snapshotCard: {
    backgroundColor: uiColors.surface,
    borderLeftWidth: 2,
    borderLeftColor: uiColors.accent,
    padding: 10,
    marginBottom: 8,
    borderRadius: 4,
  },
  logBox: {
    flex: 1,
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  logText: {
    color: uiColors.textSecondary,
    fontSize: 11,
    fontFamily: uiFonts.mono,
    lineHeight: 16,
  },
  logErr: {
    color: '#fca5a5',
  },
  logSys: {
    color: '#fde68a',
  },
  muted: {
    color: uiColors.textMuted,
    fontSize: 11,
    marginBottom: 4,
  },
  errorText: {
    color: '#f87171',
    fontSize: 11,
    paddingHorizontal: 12,
    paddingTop: 4,
  },
});
