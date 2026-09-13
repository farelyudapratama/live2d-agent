/**
 * engine/role-bridge-entry.ts — bundle IIFE untuk sandbox golden
 * (pixi8-official.html): ekspos Role Bridge (Phase 10) ke
 * `window.Live2DRoleBridge`.
 *
 * Sandbox TIDAK memuat bundle.js penuh (engine utama), jadi entry terpisah
 * memuat modul yang sama persis — satu sumber kebenaran, dua host. mapRoles
 * ikut diekspos supaya sandbox bisa memetakan role DARI model (bersama grup
 * resmi dari ModelProfile Phase 9) tanpa hard-code id.
 */
import {
  createEngineParameterLink,
  createRoleParameterBridge,
} from "./role-parameter-bridge";
import { mapRoles } from "./role-mapping";

if (typeof window !== "undefined") {
  (window as unknown as { Live2DRoleBridge: unknown }).Live2DRoleBridge = {
    createRoleParameterBridge,
    createEngineParameterLink,
    mapRoles,
  };
}

export { createEngineParameterLink, createRoleParameterBridge, mapRoles };
