module.exports = {
  preset: 'react-native',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/?(*.)+(spec|test).[jt]s?(x)'],
  testPathIgnorePatterns: [
    '<rootDir>/android/',
    '<rootDir>/node_modules/',
    '<rootDir>/release/out/',
  ],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  collectCoverageFrom: [
    'App.tsx',
    'src/**/*.{js,jsx,ts,tsx}',
    '!src/**/*.d.ts',
  ],
};
