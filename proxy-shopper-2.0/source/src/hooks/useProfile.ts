import { useCallback, useEffect, useState } from "react";
import type { CheckoutProfile } from "../types";
import { EMPTY_PROFILE } from "../types";
import { getProfile, saveProfile } from "../shared/storage";

interface UseProfile {
  profile: CheckoutProfile;
  loading: boolean;
  update(patch: Partial<CheckoutProfile>): Promise<void>;
}

export function useProfile(): UseProfile {
  const [profile, setProfile] = useState<CheckoutProfile>(EMPTY_PROFILE);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void getProfile().then((p) => {
      setProfile(p);
      setLoading(false);
    });
  }, []);

  const update = useCallback(
    async (patch: Partial<CheckoutProfile>) => {
      setProfile((prev) => {
        const next = { ...prev, ...patch };
        void saveProfile(next);
        return next;
      });
    },
    [],
  );

  return { profile, loading, update };
}
