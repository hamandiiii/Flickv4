import { useEffect, useState } from 'react';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Switch } from 'react-native';
import {
  ArrowLeft,
  FolderOpen,
  RotateCcw,
  Save,
  HardDrive,
} from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Heading } from '@/components/ui/heading';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { ScrollView } from '@/components/ui/scroll-view';
import { Input, InputField } from '@/components/ui/input';
import { Button, ButtonText } from '@/components/ui/button';
import { Focusable } from '@/src/components/Focusable';
import { EmptyState } from '@/src/components/EmptyState';
import { useDesktopStorage } from '@/src/hooks/useDesktopStorage';
import { TV_FOCUS_BORDER_CLASSNAME } from '@/src/utils/tv';

/**
 * Windows desktop only: pick where downloads and cached files are stored.
 * Hidden on iOS/Android because those platforms use app-scoped directories.
 */
export const StorageSettingsScreen = () => {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const {
    isDesktop,
    info,
    busy,
    error,
    choose,
    applyPath,
    reset,
    openFolder,
    closeToTray,
    setCloseToTray,
  } = useDesktopStorage();
  const [draft, setDraft] = useState('');
  const [savedHint, setSavedHint] = useState<string | null>(null);

  useEffect(() => {
    if (info?.dir) setDraft(info.dir);
  }, [info?.dir]);

  const handleSave = async () => {
    setSavedHint(null);
    const ok = await applyPath(draft);
    setSavedHint(ok ? 'Storage folder updated.' : null);
  };

  return (
    <Box className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <HStack space="md" className="items-center px-4 py-3">
        <Focusable
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={12}
          className="rounded-full"
          focusedClassName={TV_FOCUS_BORDER_CLASSNAME}
        >
          <Icon as={ArrowLeft} size="xl" className="text-foreground" />
        </Focusable>
        <Heading size="xl" bold className="text-foreground">
          Storage location
        </Heading>
      </HStack>

      {!isDesktop ? (
        <EmptyState
          icon={HardDrive}
          title="Desktop only"
          description="Storage location can be changed in the Windows desktop app."
        />
      ) : (
        <ScrollView className="flex-1 px-4">
          <VStack space="xl" className="pb-10">
            <Text className="text-muted-foreground">
              Choose the folder where CoFFe House saves downloads and cached
              files. The folder is created automatically if it does not exist.
            </Text>

            <VStack space="sm">
              <Text size="sm" className="text-muted-foreground">
                Current folder
              </Text>
              <Box className="rounded-md bg-card px-4 py-3">
                <Text className="text-foreground" numberOfLines={2}>
                  {info?.dir ?? 'Loading…'}
                </Text>
              </Box>
              <HStack space="sm" className="mt-2">
                <Button
                  onPress={choose}
                  isDisabled={busy}
                  className="flex-1 rounded-md bg-primary"
                >
                  <Icon as={FolderOpen} className="mr-2 text-primary-foreground" />
                  <ButtonText className="text-primary-foreground">
                    Browse…
                  </ButtonText>
                </Button>
                <Button
                  onPress={openFolder}
                  isDisabled={busy}
                  variant="outline"
                  className="rounded-md border-border"
                >
                  <ButtonText className="text-foreground">Open</ButtonText>
                </Button>
              </HStack>
            </VStack>

            <VStack space="sm">
              <Text size="sm" className="text-muted-foreground">
                Or type a path
              </Text>
              <Input className="rounded-md border-border bg-card">
                <InputField
                  value={draft}
                  onChangeText={setDraft}
                  placeholder="D:\\CoFFe House"
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="text-foreground"
                />
              </Input>
              <Button
                onPress={handleSave}
                isDisabled={busy}
                className="mt-2 rounded-md bg-primary"
              >
                <Icon as={Save} className="mr-2 text-primary-foreground" />
                <ButtonText className="text-primary-foreground">Save path</ButtonText>
              </Button>
            </VStack>

            <VStack space="sm">
              <Text size="sm" className="text-muted-foreground">
                Default folder
              </Text>
              <Box className="rounded-md bg-card px-4 py-3">
                <Text className="text-muted-foreground" numberOfLines={2}>
                  {info?.defaultDir ?? '—'}
                </Text>
              </Box>
              <Button
                onPress={reset}
                isDisabled={busy}
                variant="outline"
                className="mt-2 rounded-md border-border"
              >
                <Icon as={RotateCcw} className="mr-2 text-foreground" />
                <ButtonText className="text-foreground">Restore default</ButtonText>
              </Button>
            </VStack>

            {error ? (
              <Text className="text-destructive">{error}</Text>
            ) : null}
            {savedHint ? (
              <Text className="text-primary">{savedHint}</Text>
            ) : null}

            <VStack space="sm">
              <Text size="sm" className="text-muted-foreground">
                Window behaviour
              </Text>
              <HStack className="items-center justify-between rounded-lg bg-card px-4 py-4">
                <VStack className="flex-1">
                  <Text className="text-foreground">Close to tray</Text>
                  <Text size="xs" className="text-muted-foreground">
                    Keep CoFFe House running in the notification area when the
                    window is closed, so downloads continue. Use the tray menu
                    to quit.
                  </Text>
                </VStack>
                <Switch
                  value={closeToTray}
                  onValueChange={(value) => void setCloseToTray(value)}
                  trackColor={{ true: '#E50914', false: '#2E2E2E' }}
                  thumbColor="#FFFFFF"
                />
              </HStack>
            </VStack>
          </VStack>
        </ScrollView>
      )}
    </Box>
  );
};
