using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace VibeSultan.Sultan.Observer.State
{
    public sealed class SceneSnapshot
    {
        public int schemaVersion { get; set; } = 1;
        public long snapshotVersion { get; set; }
        public string capturedAt { get; set; }
        public SceneDescriptor scene { get; set; } = new SceneDescriptor();
        public SceneInstruction instruction { get; set; }
        public List<UiElementInfo> elements { get; set; } = new List<UiElementInfo>();
        public List<UiAffordanceInfo> affordances { get; set; } = new List<UiAffordanceInfo>();
        public Dictionary<string, object> telemetry { get; set; } = new Dictionary<string, object>();
        public bool truncated { get; set; }
        public Dictionary<string, object> diagnostics { get; set; } = new Dictionary<string, object>();
    }

    public sealed class SceneDescriptor
    {
        public string id { get; set; }
        public string name { get; set; }
        public string phase { get; set; }
        public string modal { get; set; }
        public bool blocking { get; set; }
    }

    public sealed class SceneInstruction
    {
        public string source { get; set; }
        public string type { get; set; }
        public string text { get; set; }
        public string hint { get; set; }
        public string preferredOp { get; set; }
    }

    public sealed class UiBounds
    {
        public float x { get; set; }
        public float y { get; set; }
        public float width { get; set; }
        public float height { get; set; }
    }

    public sealed class UiElementInfo
    {
        public string elementId { get; set; }
        public string parentId { get; set; }
        public string role { get; set; }
        public string name { get; set; }
        public string text { get; set; }
        public string path { get; set; }
        public string overlayId { get; set; }
        public bool visible { get; set; }
        public bool interactable { get; set; }
        public bool selected { get; set; }
        public bool blocked { get; set; }
        public UiBounds bounds { get; set; }
        public string preferredOp { get; set; }
        public Dictionary<string, object> actionParams { get; set; }
        public int? instanceId { get; set; }
    }

    public sealed class UiAffordanceInfo
    {
        public string action { get; set; }
        public string targetId { get; set; }
        public string label { get; set; }
        public bool enabled { get; set; }
        public string reason { get; set; }
        public string mapsToOp { get; set; }
        public Dictionary<string, object> parameters { get; set; }
    }

    public sealed class SceneDiff
    {
        public bool changed { get; set; }
        public bool screenChanged { get; set; }
        public string result { get; set; }
        public long? sceneBeforeVersion { get; set; }
        public long? sceneAfterVersion { get; set; }
        public Dictionary<string, object> changes { get; set; } = new Dictionary<string, object>();
    }

    public static class SceneText
    {
        private static readonly Regex RichText = new Regex("<[^>]+>", RegexOptions.Compiled);
        private static readonly Regex Whitespace = new Regex("\\s+", RegexOptions.Compiled);

        public static string Normalize(string value, int maxLength = 240)
        {
            if (string.IsNullOrWhiteSpace(value)) return null;
            var text = RichText.Replace(value, " ");
            text = Whitespace.Replace(text.Replace("\u00a0", " "), " ").Trim();
            if (text.Length == 0) return null;
            return text.Length <= maxLength ? text : text.Substring(0, maxLength) + "…";
        }
    }

    public static class SceneElementId
    {
        public static string Create(string sceneId, string path, string role)
        {
            var canonical = string.Join("|",
                NormalizePart(sceneId),
                NormalizePath(path),
                NormalizePart(role));
            return "ui:" + Fnv1a64(canonical).ToString("x16");
        }

        public static string Semantic(string semanticId)
        {
            return "semantic:" + NormalizePart(semanticId);
        }

        private static string NormalizePath(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "root";
            var parts = value.Replace('\\', '/').Split('/');
            var normalized = new List<string>();
            foreach (var part in parts)
            {
                var item = NormalizePart(part);
                if (!string.IsNullOrEmpty(item)) normalized.Add(item);
            }
            return normalized.Count == 0 ? "root" : string.Join("/", normalized);
        }

        private static string NormalizePart(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "unknown";
            var sb = new StringBuilder();
            foreach (var c in value.Trim().ToLowerInvariant())
            {
                if (char.IsLetterOrDigit(c) || c == '_' || c == '-') sb.Append(c);
                else if (char.IsWhiteSpace(c)) sb.Append('_');
            }
            return sb.Length == 0 ? "unknown" : sb.ToString();
        }

        private static ulong Fnv1a64(string value)
        {
            const ulong offset = 14695981039346656037UL;
            const ulong prime = 1099511628211UL;
            var hash = offset;
            foreach (var b in Encoding.UTF8.GetBytes(value ?? ""))
            {
                hash ^= b;
                hash *= prime;
            }
            return hash;
        }
    }

    public static class SceneSnapshotNormalizer
    {
        public static SceneSnapshot Normalize(
            SceneSnapshot snapshot,
            int maxElements = 160,
            int maxAffordances = 160)
        {
            snapshot ??= new SceneSnapshot();
            var elementCount = snapshot.elements?.Count ?? 0;
            var affordanceCount = snapshot.affordances?.Count ?? 0;
            snapshot.elements = (snapshot.elements ?? new List<UiElementInfo>())
                .Where(e => e != null && !string.IsNullOrWhiteSpace(e.elementId))
                .GroupBy(e => e.elementId, StringComparer.OrdinalIgnoreCase)
                .Select(g => g.First())
                .OrderByDescending(e => e.interactable)
                .ThenBy(e => e.role)
                .ThenBy(e => e.elementId)
                .Take(Math.Max(0, maxElements))
                .ToList();
            snapshot.affordances = (snapshot.affordances ?? new List<UiAffordanceInfo>())
                .Where(a => a != null)
                .GroupBy(a => (a.action ?? "") + "|" + (a.targetId ?? ""), StringComparer.OrdinalIgnoreCase)
                .Select(g => g.First())
                .OrderByDescending(a => a.enabled)
                .ThenBy(a => a.action)
                .ThenBy(a => a.targetId)
                .Take(Math.Max(0, maxAffordances))
                .ToList();
            snapshot.truncated = snapshot.truncated
                                 || elementCount > snapshot.elements.Count
                                 || affordanceCount > snapshot.affordances.Count;
            return snapshot;
        }
    }

    public static class SceneForegroundFilter
    {
        public static SceneSnapshot Apply(SceneSnapshot snapshot)
        {
            if (snapshot?.scene?.blocking != true || string.IsNullOrWhiteSpace(snapshot.scene.modal))
            {
                return snapshot;
            }

            var enabledAffordances = (snapshot.affordances ?? new List<UiAffordanceInfo>())
                .Where(a => a != null && a.enabled)
                .ToList();
            var enabledTargets = new HashSet<string>(
                enabledAffordances
                    .Where(a => !string.IsNullOrWhiteSpace(a.targetId))
                    .Select(a => a.targetId),
                StringComparer.OrdinalIgnoreCase);

            snapshot.elements = (snapshot.elements ?? new List<UiElementInfo>())
                .Where(e => e != null
                            && (string.Equals(
                                    e.overlayId,
                                    snapshot.scene.modal,
                                    StringComparison.OrdinalIgnoreCase)
                                || enabledTargets.Contains(e.elementId)))
                .ToList();
            snapshot.affordances = enabledAffordances;
            snapshot.diagnostics["backgroundFiltered"] = true;
            return snapshot;
        }
    }
}
