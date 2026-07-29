import {spawnSync} from 'node:child_process';

const result = spawnSync('java', ['-version'], {
  encoding: 'utf8',
  shell: false,
});
if (result.error) {
  throw new Error(
    `Java was not found. Install JDK 17 and set JAVA_HOME: ${result.error.message}`,
  );
}
const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
const match = output.match(/version "(?:1\.)?(\d+)(?:[._"])/);
if (!match) {
  throw new Error(`Could not parse java -version output:\n${output.trim()}`);
}
const major = Number(match[1]);
if (major !== 17) {
  throw new Error(
    `MobileIDE Android builds require JDK 17; detected JDK ${major}. ` +
      'Set JAVA_HOME to a JDK 17 installation before running Gradle.',
  );
}
process.stdout.write(`JDK gate passed: Java ${major}.\n`);
