import React from 'react';
import Svg, { Path, Rect, Circle, Line, Polyline } from 'react-native-svg';

export type IconName =
  | 'files'
  | 'search'
  | 'git'
  | 'settings'
  | 'terminal'
  | 'plus'
  | 'close'
  | 'menu'
  | 'editor'
  | 'folder'
  | 'folder-open'
  | 'file'
  | 'chevron-right'
  | 'chevron-down'
  | 'play'
  | 'problems'
  | 'output'
  | 'debug'
  | 'refresh'
  | 'keyboard'
  | 'copy'
  | 'save'
  | 'arrow-left'
  | 'arrow-up'
  | 'arrow-down'
  | 'arrow-right'
  | 'trash';

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

/**
 * Lightweight, dependency-light vector icon set (Feather-style 24x24 grid).
 * Replaces emoji glyphs so icons render crisply on every device.
 */
export const Icon: React.FC<IconProps> = ({
  name,
  size = 22,
  color = '#cccccc',
  strokeWidth = 2,
}) => {
  const stroke = {
    stroke: color,
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none' as const,
  };

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {renderPaths(name, color, stroke)}
    </Svg>
  );
};

function renderPaths(
  name: IconName,
  color: string,
  stroke: {
    stroke: string;
    strokeWidth: number;
    strokeLinecap: 'round';
    strokeLinejoin: 'round';
    fill: 'none';
  },
) {
  switch (name) {
    case 'files':
      return (
        <>
          <Path {...stroke} d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
          <Polyline {...stroke} points="13 2 13 9 20 9" />
        </>
      );
    case 'search':
      return (
        <>
          <Circle {...stroke} cx="11" cy="11" r="7" />
          <Line {...stroke} x1="21" y1="21" x2="16.5" y2="16.5" />
        </>
      );
    case 'git':
      return (
        <>
          <Circle {...stroke} cx="6" cy="6" r="2.5" />
          <Circle {...stroke} cx="6" cy="18" r="2.5" />
          <Circle {...stroke} cx="18" cy="9" r="2.5" />
          <Path {...stroke} d="M18 11.5a6 6 0 0 1-6 6H6" />
          <Line {...stroke} x1="6" y1="8.5" x2="6" y2="15.5" />
        </>
      );
    case 'settings':
      return (
        <>
          <Circle {...stroke} cx="12" cy="12" r="3" />
          <Path
            {...stroke}
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
          />
        </>
      );
    case 'terminal':
      return (
        <>
          <Rect {...stroke} x="3" y="4" width="18" height="16" rx="2" />
          <Polyline {...stroke} points="7 9 10 12 7 15" />
          <Line {...stroke} x1="13" y1="15" x2="17" y2="15" />
        </>
      );
    case 'plus':
      return (
        <>
          <Line {...stroke} x1="12" y1="5" x2="12" y2="19" />
          <Line {...stroke} x1="5" y1="12" x2="19" y2="12" />
        </>
      );
    case 'close':
      return (
        <>
          <Line {...stroke} x1="6" y1="6" x2="18" y2="18" />
          <Line {...stroke} x1="18" y1="6" x2="6" y2="18" />
        </>
      );
    case 'menu':
      return (
        <>
          <Line {...stroke} x1="3" y1="6" x2="21" y2="6" />
          <Line {...stroke} x1="3" y1="12" x2="21" y2="12" />
          <Line {...stroke} x1="3" y1="18" x2="21" y2="18" />
        </>
      );
    case 'editor':
      return (
        <>
          <Polyline {...stroke} points="16 18 22 12 16 6" />
          <Polyline {...stroke} points="8 6 2 12 8 18" />
        </>
      );
    case 'folder':
      return (
        <Path
          {...stroke}
          d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
        />
      );
    case 'folder-open':
      return (
        <>
          <Path {...stroke} d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3z" />
          <Path {...stroke} d="M3 10h18l-2 8a2 2 0 0 1-2 1.5H5A2 2 0 0 1 3 18z" />
        </>
      );
    case 'file':
      return (
        <>
          <Path {...stroke} d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
          <Polyline {...stroke} points="13 2 13 9 20 9" />
        </>
      );
    case 'chevron-right':
      return <Polyline {...stroke} points="9 6 15 12 9 18" />;
    case 'chevron-down':
      return <Polyline {...stroke} points="6 9 12 15 18 9" />;
    case 'arrow-left':
      return (
        <>
          <Line {...stroke} x1="20" y1="12" x2="4" y2="12" />
          <Polyline {...stroke} points="10 18 4 12 10 6" />
        </>
      );
    case 'arrow-up':
      return (
        <>
          <Line {...stroke} x1="12" y1="20" x2="12" y2="4" />
          <Polyline {...stroke} points="6 10 12 4 18 10" />
        </>
      );
    case 'arrow-down':
      return (
        <>
          <Line {...stroke} x1="12" y1="4" x2="12" y2="20" />
          <Polyline {...stroke} points="6 14 12 20 18 14" />
        </>
      );
    case 'arrow-right':
      return (
        <>
          <Line {...stroke} x1="4" y1="12" x2="20" y2="12" />
          <Polyline {...stroke} points="14 6 20 12 14 18" />
        </>
      );
    case 'play':
      return <Path {...stroke} fill={color} d="M6 4l14 8-14 8z" />;
    case 'problems':
      return (
        <>
          <Path {...stroke} d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          <Line {...stroke} x1="12" y1="9" x2="12" y2="13" />
          <Line {...stroke} x1="12" y1="17" x2="12.01" y2="17" />
        </>
      );
    case 'output':
      return (
        <>
          <Rect {...stroke} x="3" y="4" width="18" height="16" rx="2" />
          <Line {...stroke} x1="7" y1="9" x2="17" y2="9" />
          <Line {...stroke} x1="7" y1="13" x2="17" y2="13" />
          <Line {...stroke} x1="7" y1="17" x2="13" y2="17" />
        </>
      );
    case 'debug':
      return (
        <>
          <Rect {...stroke} x="8" y="7" width="8" height="11" rx="4" />
          <Line {...stroke} x1="12" y1="3" x2="12" y2="7" />
          <Line {...stroke} x1="4" y1="10" x2="8" y2="11" />
          <Line {...stroke} x1="20" y1="10" x2="16" y2="11" />
          <Line {...stroke} x1="4" y1="18" x2="8" y2="16" />
          <Line {...stroke} x1="20" y1="18" x2="16" y2="16" />
        </>
      );
    case 'refresh':
      return (
        <>
          <Polyline {...stroke} points="23 4 23 10 17 10" />
          <Path {...stroke} d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10" />
        </>
      );
    case 'keyboard':
      return (
        <>
          <Rect {...stroke} x="2" y="6" width="20" height="12" rx="2" />
          <Line {...stroke} x1="6" y1="10" x2="6.01" y2="10" />
          <Line {...stroke} x1="10" y1="10" x2="10.01" y2="10" />
          <Line {...stroke} x1="14" y1="10" x2="14.01" y2="10" />
          <Line {...stroke} x1="18" y1="10" x2="18.01" y2="10" />
          <Line {...stroke} x1="8" y1="14" x2="16" y2="14" />
        </>
      );
    case 'copy':
      return (
        <>
          <Rect {...stroke} x="9" y="9" width="11" height="11" rx="2" />
          <Path {...stroke} d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </>
      );
    case 'save':
      return (
        <>
          <Path {...stroke} d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
          <Polyline {...stroke} points="17 21 17 13 7 13 7 21" />
          <Polyline {...stroke} points="7 3 7 8 15 8" />
        </>
      );
    case 'trash':
      return (
        <>
          <Polyline {...stroke} points="3 6 5 6 21 6" />
          <Path {...stroke} d="M8 6V4h8v2M19 6l-1 14H6L5 6" />
          <Line {...stroke} x1="10" y1="10" x2="10" y2="16" />
          <Line {...stroke} x1="14" y1="10" x2="14" y2="16" />
        </>
      );
    default:
      return null;
  }
}

export default Icon;
