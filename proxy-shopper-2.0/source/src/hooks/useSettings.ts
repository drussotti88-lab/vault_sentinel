import { useCallback, useEffect, useState } from "react";
import type { UserSettings } from "../types";
import { DEFAULT_SETTINGS } from "../types";
import { getSettings, onSettingsChanged, saveSettings } from "../shared/storage";

interface UseSettings {
  settings: UserSettings;
  loading: boolean;
  update(patch: Partial<UserSettings>): Promise<void>;
}

export function useSettings(): UseSettings {
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void getSettings().then((s) => {
      setSettings(s);
      setLoading(false);
    });
    return onSettingsChanged(setSettings);
  }, []);

  const update = useCallback(
    async (patch: Partial<UserSettings>) => {
      const next = { ...settings, ...patch };
      setSettings(next);
      await saveSettings(next);
    },
    [settings],
  );

  return { settings, loading, update };
}
