/**
 * settingsStore — persists user notification preferences via Zustand persist middleware.
 * Consistent with walletStore pattern. All notifications default to true on first load.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  DEFAULT_CONCENTRATION_THRESHOLDS,
  SNOOZE_DURATIONS_MS,
  type ConcentrationThresholds,
  type SnoozeEntry,
} from "@/lib/concentrationRisk";
import { createPersistentJSONStorage } from "@/store/storageAdapter";

export type MaturityReminderDays = 1 | 3 | 7;
export type Persona = "investor" | "sme";

export interface NotificationPrefs {
  maturityReminder: boolean;
  fundingAlerts: boolean;
  repaymentAlerts: boolean;
  maturityReminderDays: MaturityReminderDays;
}

export interface TourSettings {
  persona: Persona;
  stepIndex: number;
  completed: boolean;
  skipped: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  maturityReminder: true,
  fundingAlerts: true,
  repaymentAlerts: true,
  maturityReminderDays: 3,
};

export const DEFAULT_TOUR_SETTINGS: TourSettings = {
  persona: "investor",
  stepIndex: 0,
  completed: false,
  skipped: false,
};

const TOUR_STORAGE_KEY = "kora-tour-done";

/**
 * Concentration alert state (issue #604).
 *
 * Dismissals and snoozes are keyed by `dimension:bucket`, not by percentage, so
 * a dismissal survives the number moving. Otherwise every recomputation would
 * resurrect an alert the investor had already acknowledged.
 */
export interface ConcentrationSettings {
  thresholds: ConcentrationThresholds;
  dismissedKeys: string[];
  snoozes: SnoozeEntry[];
}

export const DEFAULT_CONCENTRATION_SETTINGS: ConcentrationSettings = {
  thresholds: DEFAULT_CONCENTRATION_THRESHOLDS,
  dismissedKeys: [],
  snoozes: [],
};

/**
 * Storage schema version (#1125).
 *
 * v0 wrote whatever was in memory with no validation, so a partial write, an
 * older shape, or a hand-edited entry could put `stepIndex: "3"` or
 * `persona: "admin"` into the tour state and strand the onboarding flow.
 */
export const SETTINGS_STORAGE_VERSION = 1;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function sanitizeNotifications(
  value: unknown,
  fallback: NotificationPrefs,
): NotificationPrefs {
  const raw = asRecord(value);
  const days = raw.maturityReminderDays;
  return {
    maturityReminder:
      typeof raw.maturityReminder === "boolean"
        ? raw.maturityReminder
        : fallback.maturityReminder,
    fundingAlerts:
      typeof raw.fundingAlerts === "boolean" ? raw.fundingAlerts : fallback.fundingAlerts,
    repaymentAlerts:
      typeof raw.repaymentAlerts === "boolean"
        ? raw.repaymentAlerts
        : fallback.repaymentAlerts,
    maturityReminderDays:
      days === 1 || days === 3 || days === 7 ? days : fallback.maturityReminderDays,
  };
}

/**
 * The tour slice is the one that has to survive a refresh intact: `stepIndex`
 * is what resumes the tour where the user left it (#1125), so it is coerced
 * back to a safe integer rather than trusted.
 */
function sanitizeTour(value: unknown, fallback: TourSettings): TourSettings {
  const raw = asRecord(value);
  const stepIndex =
    typeof raw.stepIndex === "number" && Number.isFinite(raw.stepIndex)
      ? Math.max(0, Math.floor(raw.stepIndex))
      : fallback.stepIndex;
  return {
    persona: raw.persona === "sme" ? "sme" : "investor",
    stepIndex,
    completed: raw.completed === true,
    skipped: raw.skipped === true,
  };
}

function sanitizeConcentration(
  value: unknown,
  fallback: ConcentrationSettings,
): ConcentrationSettings {
  const raw = asRecord(value);
  const rawThresholds = asRecord(raw.thresholds);
  const thresholds: ConcentrationThresholds = { ...fallback.thresholds };
  for (const key of Object.keys(thresholds) as Array<keyof ConcentrationThresholds>) {
    const candidate = rawThresholds[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      thresholds[key] = candidate;
    }
  }

  const dismissedKeys = Array.isArray(raw.dismissedKeys)
    ? raw.dismissedKeys.filter((key): key is string => typeof key === "string")
    : [];

  const snoozes: SnoozeEntry[] = Array.isArray(raw.snoozes)
    ? raw.snoozes.filter((entry): entry is SnoozeEntry => {
        if (entry === null || typeof entry !== "object") return false;
        const { key, until } = entry as { key?: unknown; until?: unknown };
        return (
          typeof key === "string" &&
          typeof until === "number" &&
          Number.isFinite(until) &&
          until > Date.now()
        );
      })
    : [];

  return { thresholds, dismissedKeys, snoozes };
}

/** Normalize whatever was read from storage into a complete settings slice. */
function sanitizeSettings(value: unknown): Pick<
  SettingsStore,
  "notifications" | "tour" | "concentration"
> {
  const raw = asRecord(value);
  return {
    notifications: sanitizeNotifications(raw.notifications, DEFAULT_NOTIFICATION_PREFS),
    tour: sanitizeTour(raw.tour, DEFAULT_TOUR_SETTINGS),
    concentration: sanitizeConcentration(
      raw.concentration,
      DEFAULT_CONCENTRATION_SETTINGS,
    ),
  };
}

interface SettingsStore {
  notifications: NotificationPrefs;
  setNotifications: (prefs: Partial<NotificationPrefs>) => void;
  resetNotifications: () => void;
  tour: TourSettings;
  setTourSettings: (settings: Partial<TourSettings>) => void;
  resetTourSettings: () => void;
  restartTour: (persona?: Persona) => void;
  concentration: ConcentrationSettings;
  setConcentrationThresholds: (thresholds: Partial<ConcentrationThresholds>) => void;
  dismissConcentrationAlert: (key: string) => void;
  snoozeConcentrationAlert: (key: string, durationMs?: number) => void;
  resetConcentrationAlerts: () => void;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      notifications: DEFAULT_NOTIFICATION_PREFS,
      setNotifications: (prefs) =>
        set((s) => ({ notifications: { ...s.notifications, ...prefs } })),
      resetNotifications: () => set({ notifications: DEFAULT_NOTIFICATION_PREFS }),
      tour: DEFAULT_TOUR_SETTINGS,
      setTourSettings: (settings) =>
        set((s) => {
          const nextTour = { ...s.tour, ...settings };
          if (typeof window !== "undefined") {
            if (nextTour.completed || nextTour.skipped) {
              try {
                localStorage.setItem(TOUR_STORAGE_KEY, "true");
              } catch {
                // storage unavailable
              }
            }
          }
          return { tour: nextTour };
        }),
      resetTourSettings: () => {
        if (typeof window !== "undefined") {
          try {
            localStorage.removeItem(TOUR_STORAGE_KEY);
          } catch {
            // storage unavailable
          }
        }
        set({ tour: DEFAULT_TOUR_SETTINGS });
      },
      concentration: DEFAULT_CONCENTRATION_SETTINGS,
      setConcentrationThresholds: (thresholds) =>
        set((s) => ({
          concentration: {
            ...s.concentration,
            thresholds: { ...s.concentration.thresholds, ...thresholds },
          },
        })),
      dismissConcentrationAlert: (key) =>
        set((s) => ({
          concentration: {
            ...s.concentration,
            dismissedKeys: s.concentration.dismissedKeys.includes(key)
              ? s.concentration.dismissedKeys
              : [...s.concentration.dismissedKeys, key],
          },
        })),
      snoozeConcentrationAlert: (key, durationMs = SNOOZE_DURATIONS_MS.day) =>
        set((s) => ({
          concentration: {
            ...s.concentration,
            // Replace any existing snooze for this key rather than stacking, so
            // snoozing twice does not silently double the delay.
            snoozes: [
              ...s.concentration.snoozes.filter((entry) => entry.key !== key),
              { key, until: Date.now() + durationMs },
            ],
          },
        })),
      resetConcentrationAlerts: () =>
        set((s) => ({
          concentration: { ...s.concentration, dismissedKeys: [], snoozes: [] },
        })),
      restartTour: (persona) => {
        if (typeof window !== "undefined") {
          try {
            localStorage.removeItem(TOUR_STORAGE_KEY);
          } catch {
            // storage unavailable
          }
        }
        set((s) => ({
          tour: {
            persona: persona ?? s.tour.persona,
            stepIndex: 0,
            completed: false,
            skipped: false,
          },
        }));
      },
    }),
    {
      name: "kora-settings-store",
      // Safe storage with an in-memory fallback (#1125): a blocked or full
      // localStorage must not break settings, and writes must be JSON.
      storage: createPersistentJSONStorage(),
      version: SETTINGS_STORAGE_VERSION,
      // v0 → v1: same slices, but validated instead of trusted.
      migrate: (persisted) => sanitizeSettings(persisted),
      // Always run on rehydrate (same version too): fills any slice that is
      // missing and drops fields that do not belong, without touching actions.
      merge: (persisted, current) => ({
        ...current,
        ...sanitizeSettings(persisted),
      }),
    }
  )
);

