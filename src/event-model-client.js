import {
  clearNativeEventModelDiagnostics,
  generateNativeEventDetails,
  getNativeEventModelDiagnostics,
  isNativeEventModelBusy,
  isNativeEventModelReady,
  NATIVE_EVENT_MODEL_ID,
  prepareNativeEventModel,
} from "./native-event-model-client.js";

export const EVENT_MODEL_ID = NATIVE_EVENT_MODEL_ID;
export const EVENT_MODEL_RUNTIME_VERSION = 30;

export function prepareEventModel() {
  return prepareNativeEventModel();
}

export function generateEventDetails(input, detectedEvent) {
  return generateNativeEventDetails({ ...input, detectedEvent });
}

export async function clearEventModelDiagnostics() {
  const native = await clearNativeEventModelDiagnostics();
  await messenger.storage.local.remove("eventModelDiagnostics");
  return { native };
}

export async function getEventModelDiagnostics() {
  return {
    generatedAt: new Date().toISOString(),
    activeBackend: "native",
    nativeCompanion: await getNativeEventModelDiagnostics(),
  };
}

export function isEventModelReady() {
  return isNativeEventModelReady();
}

export function isEventModelBusy() {
  return isNativeEventModelBusy();
}
