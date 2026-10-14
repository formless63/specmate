import { useCallback, useMemo, useState } from "react";
import type { Address, SharedScene } from "../shared-scene/api";
import type { ProbeTarget } from "../navigation/url";
import { useProbe, useRelated, useRelationContributor, type ProbeMark } from "./ProbeProvider";
import type { RelatedTarget, RelationContributor } from "./relations";

/**
 * Contextual uses of a frozen assembly scene as probe targets. The object is the assembly the
 * scene was frozen from; the path is the occurrence path, and a stable feature (pad, endpoint,
 * component) is one last segment marked "#". Every use keeps its own path, so the second of two
 * repeated boards is a different target from the first even though both share a definition.
 */
const FEATURE = "#";

const samePath = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((segment, index) => segment === b[index]);

export function sceneTarget(scene: SharedScene, address: Address, rev: number | null = null): ProbeTarget {
  const path = [...address.path];
  if (address.feature_id) path.push(FEATURE + address.feature_id);
  return { object: scene.root.definition_id, rev, path };
}

/** The scene address a target names, or null when it is not a use (or feature) of this scene. */
export function sceneAddress(scene: SharedScene, target: ProbeTarget): Address | null {
  if (target.object !== scene.root.definition_id) return null;
  const whole = scene.nodes.find((node) => samePath(node.address.path, target.path));
  if (whole) return { snapshot_id: scene.snapshot_id, path: [...whole.address.path] };
  const last = target.path[target.path.length - 1];
  if (last === undefined || !last.startsWith(FEATURE)) return null;
  const node = scene.nodes.find((candidate) => samePath(candidate.address.path, target.path.slice(0, -1)));
  const feature = node?.features.find((candidate) => candidate.feature_id === last.slice(FEATURE.length));
  return feature ? { ...feature.address, path: [...feature.address.path] } : null;
}

const sameContext = (a: ProbeTarget, b: ProbeTarget) => a.object === b.object && samePath(a.path, b.path);
const withoutFeature = (target: ProbeTarget): ProbeTarget => {
  const last = target.path[target.path.length - 1];
  return last !== undefined && last.startsWith(FEATURE) ? { ...target, path: target.path.slice(0, -1) } : target;
};

const ROLE_WORDS: Record<string, string> = { parent: "contains", child: "contained by", mounted: "mounted on", support: "supports" };

type Reference = { role: string; path: string[]; feature: string | null };

function references(relationship: SharedScene["relationships"][number]): Reference[] {
  const found: Reference[] = [];
  for (const [role, value] of Object.entries(relationship)) {
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as { kind?: string }).kind !== "occurrence") continue;
    const ref = value as { path: string[]; feature_id?: string | null };
    found.push({ role, path: [...relationship.context_path, ...ref.path], feature: ref.feature_id ?? null });
  }
  return found;
}

/**
 * What a scene knows about how its uses relate: declared assembly relationships (the other end
 * of an electrical, mating, mounting, ... relation) and the uses nested under the selected one.
 * A selected feature matches only relationship ends that name that exact feature.
 */
export function sceneRelations(scene: SharedScene): RelationContributor {
  return {
    id: `scene:${scene.snapshot_id}`,
    *related(probe) {
      const address = sceneAddress(scene, probe);
      if (!address) return;
      const feature = address.feature_id ?? null;
      const target = (path: string[], featureId: string | null, relation: string): RelatedTarget => {
        const node = scene.nodes.find((candidate) => samePath(candidate.address.path, path));
        const known = featureId !== null && node?.features.some((candidate) => candidate.feature_id === featureId);
        return { object: probe.object, rev: probe.rev, path: known ? [...path, FEATURE + featureId] : [...path], relation };
      };
      if (!feature) {
        for (const node of scene.nodes) {
          if (node.address.path.length > address.path.length && samePath(node.address.path.slice(0, address.path.length), address.path)) {
            yield target(node.address.path, null, "contains");
          }
        }
      }
      for (const relationship of scene.relationships) {
        const ends = references(relationship);
        const mine = ends.find((end) => samePath(end.path, address.path) && (feature === null || end.feature === feature));
        if (!mine) continue;
        for (const end of ends) {
          if (end === mine || !scene.nodes.some((node) => samePath(node.address.path, end.path))) continue;
          yield target(end.path, end.feature, ROLE_WORDS[end.role] ?? relationship.kind.replaceAll("_", " "));
        }
      }
    },
  };
}

/**
 * The scene's selected address, backed by the shared probe (and so the URL) inside the shell and
 * by local state when a panel is rendered alone. Registers the scene's relations while mounted.
 */
export function useSceneProbe(scene: SharedScene | null, rev: number | null = null): [Address | null, (address: Address | null) => void, () => void] {
  const shared = useProbe();
  const [local, setLocal] = useState<Address | null>(null);
  const contributor = useMemo(() => (scene ? sceneRelations(scene) : null), [scene]);
  useRelationContributor(contributor);
  const setProbe = shared?.setProbe;
  const select = useCallback((address: Address | null) => {
    if (!setProbe) { setLocal(address); return; }
    if (address && scene) setProbe(sceneTarget(scene, address, rev));
    else setProbe(null);
  }, [setProbe, scene, rev]);
  const probe = shared?.probe ?? null;
  const selected = useMemo(() => {
    if (!shared) return scene && local && local.snapshot_id === scene.snapshot_id ? local : null;
    return scene && probe ? sceneAddress(scene, probe) : null;
  }, [shared, scene, local, probe]);
  // Forget only a panel-local selection; a shared probe is the URL and survives access re-checks.
  const forget = useCallback(() => setLocal(null), []);
  return [selected, select, forget];
}

/**
 * How a use or feature looks next to the probe: selected when it is the probed one, related when a
 * view's relations name it. An address without a feature stands for the whole use, so it is
 * selected while one of its features is probed. Revision is ignored; the scene pins it.
 */
export function useSceneMark(scene: SharedScene, address: Address): ProbeMark {
  const probe = useProbe()?.probe ?? null;
  const related = useRelated();
  if (!probe || probe.object !== scene.root.definition_id) return null;
  const own = sceneTarget(scene, address);
  const normal = address.feature_id ? (target: ProbeTarget) => target : withoutFeature;
  if (sameContext(normal(probe), own)) return "selected";
  return related.some((item) => sameContext(normal(item), own)) ? "related" : null;
}

/** Whole uses (features folded into their use) the open views relate to the probe, for the 3D viewport. */
export function useSceneRelated(scene: SharedScene | null): Address[] {
  const related = useRelated();
  return useMemo(() => {
    if (!scene) return [];
    const seen = new Map<string, Address>();
    for (const item of related) {
      const address = sceneAddress(scene, withoutFeature(item));
      if (address) seen.set(JSON.stringify(address.path), { snapshot_id: address.snapshot_id, path: address.path });
    }
    return [...seen.values()];
  }, [scene, related]);
}
