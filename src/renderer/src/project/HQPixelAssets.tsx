import React from 'react';

export function PixelPlant({ style }: { style?: React.CSSProperties }) {
  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', ...style }}>
      <div style={{ fontSize: 16, lineHeight: '14px', filter: 'drop-shadow(1px 1px 0 #000)' }}>🌿</div>
      <div
        style={{
          width: 10,
          height: 8,
          background: '#8D6E63',
          border: '1px solid #3E2723',
          borderRadius: '0 0 2px 2px'
        }}
      />
    </div>
  );
}

export function PixelComputer({
  active = true,
  screenColor = '#4FC3F7',
  style
}: {
  active?: boolean;
  screenColor?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        background: '#D7CCC8',
        border: '1.5px solid #4E342E',
        padding: '3px 6px',
        boxShadow: '1.5px 1.5px 0 #2D1E18',
        borderRadius: 1,
        ...style
      }}
    >
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        {/* Monitor */}
        <div
          style={{
            width: 18,
            height: 14,
            background: '#37474F',
            border: '1.5px solid #212121',
            borderRadius: 1,
            padding: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <div
            style={{
              width: '100%',
              height: '100%',
              background: active ? screenColor : '#263238',
              boxShadow: active ? `0 0 3px ${screenColor}` : 'none'
            }}
          />
        </div>
        {/* Tower */}
        <div
          style={{
            width: 7,
            height: 15,
            background: '#263238',
            border: '1px solid #000',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-around',
            alignItems: 'center',
            padding: '1px 0'
          }}
        >
          <div style={{ width: 4, height: 1, background: '#4CAF50' }} />
          <div style={{ width: 4, height: 1, background: '#FF5722' }} />
        </div>
      </div>
      {/* Keyboard */}
      <div
        style={{
          width: 14,
          height: 3,
          background: '#9E9E9E',
          border: '0.5px solid #424242',
          marginTop: 2
        }}
      />
    </div>
  );
}

export function PixelServerRack({ style }: { style?: React.CSSProperties }) {
  return (
    <div
      style={{
        width: 22,
        height: 34,
        background: '#212121',
        border: '2px solid #000',
        boxShadow: '2px 2px 0 #000',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 2,
        ...style
      }}
    >
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            height: 5,
            background: '#37474F',
            border: '0.5px solid #263238',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 2px'
          }}
        >
          <div style={{ display: 'flex', gap: 1.5 }}>
            <div
              style={{
                width: 2,
                height: 2,
                borderRadius: '50%',
                background: i % 2 === 0 ? '#00E676' : '#2979FF',
                boxShadow: '0 0 2px #00E676'
              }}
            />
            <div
              style={{
                width: 2,
                height: 2,
                borderRadius: '50%',
                background: '#FFD600'
              }}
            />
          </div>
          <div style={{ width: 6, height: 1, background: '#546E7A' }} />
        </div>
      ))}
    </div>
  );
}

export function PixelCharacter({
  name,
  role,
  sitting = false,
  bubbleText,
  style
}: {
  name: string;
  role?: string;
  sitting?: boolean;
  bubbleText?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        position: 'relative',
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        ...style
      }}
    >
      {/* Speech Bubble */}
      {bubbleText && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            marginBottom: 4,
            background: '#fff',
            border: '1.5px solid #000',
            boxShadow: '2px 2px 0 #000',
            padding: '2px 6px',
            borderRadius: 3,
            fontSize: 8,
            fontFamily: 'monospace',
            fontWeight: 700,
            whiteSpace: 'nowrap',
            zIndex: 10,
            color: '#000'
          }}
        >
          {bubbleText}
          {/* Bubble tail */}
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: '50%',
              marginLeft: -3,
              width: 0,
              height: 0,
              borderLeft: '3px solid transparent',
              borderRight: '3px solid transparent',
              borderTop: '3px solid #000'
            }}
          />
        </div>
      )}

      {/* Head */}
      <div
        style={{
          width: 12,
          height: 12,
          background: '#FFCC80',
          border: '1.5px solid #000',
          borderRadius: 2,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center'
        }}
      >
        {/* Hair */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 4,
            background: '#5D4037',
            borderRadius: '1px 1px 0 0'
          }}
        />
        {/* Eyes */}
        <div style={{ display: 'flex', gap: 3, marginTop: 5 }}>
          <div style={{ width: 1.5, height: 2, background: '#000' }} />
          <div style={{ width: 1.5, height: 2, background: '#000' }} />
        </div>
      </div>

      {/* Body / Suit */}
      <div
        style={{
          width: 14,
          height: sitting ? 9 : 13,
          background: '#37474F',
          border: '1.5px solid #000',
          borderTop: 'none',
          borderRadius: '0 0 1px 1px',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-start'
        }}
      >
        {/* Tie */}
        <div style={{ width: 2, height: 5, background: '#D32F2F', marginTop: 1 }} />
      </div>

      {/* Name Badge */}
      <div
        style={{
          marginTop: 2,
          fontSize: 7.5,
          fontFamily: 'monospace',
          fontWeight: 800,
          background: 'rgba(0,0,0,0.75)',
          color: '#fff',
          padding: '1px 3px',
          borderRadius: 1,
          whiteSpace: 'nowrap'
        }}
      >
        @{name}
      </div>
    </div>
  );
}

export function PixelMissionBoard({
  missionNumber,
  title,
  progress,
  color = '#0288D1',
  onClick
}: {
  missionNumber: string;
  title: string;
  progress: number;
  color?: string;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        background: '#212121',
        border: '1.5px solid #000',
        boxShadow: '2px 2px 0 #000',
        padding: '3px 5px',
        width: 82,
        cursor: onClick ? 'pointer' : 'default',
        display: 'flex',
        flexDirection: 'column',
        gap: 2
      }}
    >
      <div style={{ fontSize: 7, fontFamily: 'monospace', color: '#BDBDBD', fontWeight: 700 }}>
        {missionNumber}
      </div>
      <div
        style={{
          fontSize: 8,
          fontWeight: 800,
          color: '#fff',
          fontFamily: 'monospace',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}
      >
        {title}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 1 }}>
        <div
          style={{
            flex: 1,
            height: 4,
            background: '#424242',
            border: '0.5px solid #000',
            overflow: 'hidden',
            marginRight: 4
          }}
        >
          <div style={{ width: `${progress}%`, height: '100%', background: color }} />
        </div>
        <span style={{ fontSize: 7, fontFamily: 'monospace', color: '#fff', fontWeight: 800 }}>
          {progress}%
        </span>
      </div>
    </div>
  );
}
