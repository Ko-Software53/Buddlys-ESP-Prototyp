import { Tabs } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { Redirect } from 'expo-router';
import { Text } from 'react-native';
import { theme } from '@/styles/theme';

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.55 }}>{label}</Text>;
}

export default function MainLayout() {
  const { session, loading } = useAuth();
  if (!loading && !session) return <Redirect href="/(auth)/login" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
          paddingBottom: 4,
        },
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.textMuted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="discover"
        options={{
          title: 'Verbinden',
          tabBarIcon: ({ focused }) => <TabIcon label="📡" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="conversations"
        options={{
          title: 'Gespräche',
          tabBarIcon: ({ focused }) => <TabIcon label="💬" focused={focused} />,
        }}
      />
      {/* Detail screens — hidden from tab bar */}
      <Tabs.Screen name="wifi-setup" options={{ href: null }} />
      <Tabs.Screen name="conversation/[id]" options={{ href: null }} />
      <Tabs.Screen name="device/[id]" options={{ href: null }} />
    </Tabs>
  );
}
