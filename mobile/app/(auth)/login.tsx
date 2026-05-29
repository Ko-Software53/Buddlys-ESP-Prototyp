import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
} from 'react-native';
import { Link, router } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { BrandWordmark } from '@/components/BrandMark';
import { shadow, theme } from '@/styles/theme';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!email || !password) return;
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      Alert.alert('Anmeldung fehlgeschlagen', error.message);
    } else {
      router.replace('/(main)/discover');
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.inner}>
        <View style={styles.logoWrap}>
          <BrandWordmark width={184} />
        </View>
        <Text style={styles.subtitle}>Dein sprechender Freund</Text>

        <View style={styles.form}>
          <TextInput
            style={styles.input}
            placeholder="E-Mail"
            placeholderTextColor={theme.colors.textSoft}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={styles.input}
            placeholder="Passwort"
            placeholderTextColor={theme.colors.textSoft}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />

          <TouchableOpacity
            style={[styles.btn, loading && styles.btnDisabled]}
            onPress={handleLogin}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color={theme.colors.white} />
              : <Text style={styles.btnText}>Anmelden</Text>
            }
          </TouchableOpacity>

          <Link href="/(auth)/signup" asChild>
            <TouchableOpacity style={styles.link}>
              <Text style={styles.linkText}>Noch kein Konto? Registrieren</Text>
            </TouchableOpacity>
          </Link>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  inner: { flex: 1, justifyContent: 'center', paddingHorizontal: 32 },
  logoWrap: { alignItems: 'center' },
  subtitle: { fontSize: 15, color: theme.colors.textMuted, textAlign: 'center', marginTop: 10, marginBottom: 44 },
  form: { gap: 12 },
  input: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: theme.colors.text,
    fontSize: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...shadow,
  },
  btn: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.md,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 4,
    ...shadow,
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: theme.colors.white, fontWeight: '700', fontSize: 16 },
  link: { alignItems: 'center', paddingVertical: 12 },
  linkText: { color: theme.colors.primary, fontSize: 14, fontWeight: '600' },
});
