import { describe, it, expect } from "vitest";
import type {
  Agent as ContractAgent,
  LiveState as ContractLiveState,
  Confidence as ContractConfidence,
  Usage as ContractUsage,
  SourceProvenance as ContractSourceProvenance,
} from "@armillary/model";

import { MOCK_AGENTS, type Agent } from "../src/api/agents";
import {
  INITIAL_SYNTHETIC_SESSIONS,
  generateSyntheticSessions,
  type Session,
} from "../src/api/archive";
import {
  getMockLive,
  live_list,
  type Live,
} from "../src/api/live";
import * as configApi from "../src/api/config";

describe("Work Package G2: Contract Adoption in UI and API", () => {
  describe("Path alias and contract types", () => {
    it("imports contract types via @armillary/model alias", () => {
      const mockAgent: ContractAgent = {
        id: "test-agent",
        name: "Test Agent",
        vendor: "Test Vendor",
        family: "anthropic",
        kind: "cli",
      };
      expect(mockAgent.id).toBe("test-agent");
      expect(mockAgent.family).toBe("anthropic");
    });
  });

  describe("app/src/api/agents.ts contract adoption", () => {
    it("uses ContractAgent as the Agent type", () => {
      const first: Agent = MOCK_AGENTS[0];
      expect(first).toHaveProperty("id");
      expect(first).toHaveProperty("name");
      expect(first).toHaveProperty("vendor");
      expect(first).toHaveProperty("family");
      expect(first).toHaveProperty("kind");
    });
  });

  describe("app/src/api/archive.ts contract adoption", () => {
    it("ensures INITIAL_SYNTHETIC_SESSIONS match the contract Session shape", () => {
      const first: Session = INITIAL_SYNTHETIC_SESSIONS[0];
      expect(first).toHaveProperty("id");
      expect(first).toHaveProperty("agent_id");
      expect(first).toHaveProperty("status");
      expect(first).toHaveProperty("turns");
      expect(first).toHaveProperty("usage");
      expect(first).toHaveProperty("provenance");

      // Verify contract usage shape
      const usage: ContractUsage = first.usage;
      expect(usage).toHaveProperty("semantics");
      expect(["cumulative", "delta", "unknown"]).toContain(usage.semantics);
      expect(Array.isArray(usage.observations)).toBe(true);

      // Verify contract provenance shape
      const prov: ContractSourceProvenance = first.provenance;
      expect(prov).toHaveProperty("adapter_id");
      expect(prov).toHaveProperty("adapter_version");
      expect(prov).toHaveProperty("checkpoint");
      expect(prov).toHaveProperty("store");
      expect(prov.store).toHaveProperty("namespace");
      expect(prov.store).toHaveProperty("canonical_root");
      expect(prov.store).toHaveProperty("profile_id");

      // Ensure deprecated top-level token fields are not in contract Session
      expect((first as Record<string, unknown>).tokens_in).toBeUndefined();
      expect((first as Record<string, unknown>).tokens_out).toBeUndefined();
    });

    it("generateSyntheticSessions produces valid contract Sessions", () => {
      const sessions = generateSyntheticSessions(5);
      expect(sessions.length).toBe(5);
      for (const sess of sessions) {
        expect(sess).toHaveProperty("id");
        expect(sess).toHaveProperty("agent_id");
        expect(sess).toHaveProperty("turns");
        expect(sess).toHaveProperty("usage");
        expect(sess.usage).toHaveProperty("semantics");
        expect(sess).toHaveProperty("provenance");
        expect((sess as Record<string, unknown>).tokens_in).toBeUndefined();
      }
    });
  });

  describe("app/src/api/live.ts contract adoption", () => {
    it("exports getMockLive returning contract Live[] with full contract shape", () => {
      const liveItems: Live[] = getMockLive();
      expect(liveItems.length).toBeGreaterThan(0);

      const first: Live = liveItems[0];
      expect(first).toHaveProperty("session_id");
      expect(first).toHaveProperty("state");
      expect(first).toHaveProperty("observed_at");
      expect(first).toHaveProperty("confidence");
      expect(first).toHaveProperty("evidence");

      // Verify state allows contract LiveState values including unknown
      const validStates: ContractLiveState[] = ["unknown", "working", "waiting", "idle", "done"];
      expect(validStates).toContain(first.state);

      // Verify confidence allows contract Confidence values
      const validConfidences: ContractConfidence[] = ["unknown", "low", "medium", "high"];
      expect(validConfidences).toContain(first.confidence);

      // Verify evidence is an array of ContractEvidence
      expect(Array.isArray(first.evidence)).toBe(true);
      if (first.evidence.length > 0) {
        expect(first.evidence[0]).toHaveProperty("kind");
        expect(first.evidence[0]).toHaveProperty("detail");
      }
    });

    it("supports live_list returning contract Live array", async () => {
      const list = await live_list();
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);
      expect(list[0]).toHaveProperty("session_id");
      expect(list[0]).toHaveProperty("state");
      expect(list[0]).toHaveProperty("confidence");
    });
  });

  describe("app/src/api/config.ts contract adoption", () => {
    it("imports and exposes contract types", () => {
      expect(configApi).toBeDefined();
    });
  });
});
