import { Image, StyleSheet, View } from 'react-native';

const wordmark = require('../../assets/logo-buddlys-blue.png');
const signet = require('../../assets/logo-buddlys-signet-blue.png');

export function BrandWordmark({ width = 168 }: { width?: number }) {
  return (
    <Image
      source={wordmark}
      resizeMode="contain"
      style={{ width, height: Math.round(width / 4.813) }}
    />
  );
}

export function BrandSignet({ size = 42 }: { size?: number }) {
  return (
    <View style={[styles.signetFrame, { width: size, height: size }]}>
      <Image
        source={signet}
        resizeMode="contain"
        style={{ width: size * 0.7, height: size * 0.6 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  signetFrame: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#C9DDF4',
  },
});
