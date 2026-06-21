'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, sessionToken, accessCodeConfigured } from '@/lib/auth';
import { controlApi, type AddItemInput } from '@/lib/controlApi';

/**
 * Server actions for watch-list control. Every action re-checks auth (defence in
 * depth beyond the middleware) and routes mutations through the worker's control
 * API, then revalidates the page so the table reflects the new state.
 */

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

async function assertAuthed(): Promise<void> {
  if (!accessCodeConfigured()) throw new Error('Dashboard access code is not configured.');
  const cookie = cookies().get(SESSION_COOKIE)?.value;
  if (!cookie || cookie !== (await sessionToken())) throw new Error('Not signed in.');
}

function fail(err: unknown): ActionResult {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

export async function addItemAction(input: AddItemInput): Promise<ActionResult> {
  try {
    await assertAuthed();
    if (!input.retailer) return { ok: false, error: 'Pick a retailer.' };
    if (!input.url) return { ok: false, error: 'Paste a product URL or search URL.' };
    if (input.threshold != null && !Number.isFinite(input.threshold)) {
      return { ok: false, error: 'Max price must be a number.' };
    }
    if (input.interval != null && (!Number.isInteger(input.interval) || input.interval <= 0)) {
      return { ok: false, error: 'Interval must be a positive whole number of seconds.' };
    }
    const res = await controlApi.addItem(input);
    revalidatePath('/');
    const label = res.watch?.display_name ?? res.watch?.product_id ?? 'item';
    return { ok: true, message: `Now watching “${label}”.` };
  } catch (err) {
    return fail(err);
  }
}

export async function removeItemAction(id: string): Promise<ActionResult> {
  try {
    await assertAuthed();
    await controlApi.removeItem(id);
    revalidatePath('/');
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function setEnabledAction(id: string, enabled: boolean): Promise<ActionResult> {
  try {
    await assertAuthed();
    await (enabled ? controlApi.resume(id) : controlApi.pause(id));
    revalidatePath('/');
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function setThresholdAction(id: string, threshold: number | null): Promise<ActionResult> {
  try {
    await assertAuthed();
    if (threshold != null && !Number.isFinite(threshold)) {
      return { ok: false, error: 'Max price must be a number.' };
    }
    await controlApi.setThreshold(id, threshold);
    revalidatePath('/');
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function setIntervalAction(id: string, interval: number): Promise<ActionResult> {
  try {
    await assertAuthed();
    if (!Number.isInteger(interval) || interval <= 0) {
      return { ok: false, error: 'Interval must be a positive whole number of seconds.' };
    }
    await controlApi.setInterval(id, interval);
    revalidatePath('/');
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}
