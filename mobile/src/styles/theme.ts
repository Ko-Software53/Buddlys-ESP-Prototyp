export const theme = {
  colors: {
    background: '#F4F9FF',
    backgroundDeep: '#E8F3FF',
    surface: '#FFFFFF',
    surfaceSoft: '#EAF4FF',
    surfacePressed: '#DDEEFF',
    primary: '#086BDE',
    primaryDark: '#064EA5',
    primarySoft: '#D6E9FF',
    text: '#10233F',
    textMuted: '#607089',
    textSoft: '#8AA0BA',
    border: '#C9DDF4',
    borderStrong: '#9FC3EB',
    danger: '#B4233C',
    dangerSoft: '#FFE8ED',
    success: '#1C9C66',
    white: '#FFFFFF',
  },
  radius: {
    sm: 6,
    md: 8,
    lg: 8,
  },
  spacing: {
    screen: 20,
  },
} as const;

export const shadow = {
  shadowColor: '#0A4B91',
  shadowOffset: { width: 0, height: 12 },
  shadowOpacity: 0.08,
  shadowRadius: 24,
  elevation: 3,
} as const;
