/**
 * @format
 */

import 'react-native';
import React from 'react';
import App from '../App';

jest.mock('../src/screens/IDEScreen', () => ({
  IDEScreen: () => null,
}));
jest.mock('../src/components/SplashScreen', () => ({
  SplashScreen: () => null,
}));

// Note: import explicitly to use the types shipped with jest.
import {it} from '@jest/globals';

// Note: test renderer must be required after react-native.
import renderer from 'react-test-renderer';

it('renders correctly', async () => {
  await renderer.act(() => {
    renderer.create(<App />);
  });
});
