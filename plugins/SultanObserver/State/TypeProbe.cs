using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;

namespace VibeSultan.Sultan.Observer.State
{
    /// <summary>
    /// Diagnostic type probe filtered to Game/Core/Common assemblies.
    /// Not used as a normal gameplay call path.
    /// </summary>
    public static class TypeProbe
    {
        public static Dictionary<string, object> LastReport { get; private set; }

        private static readonly string[] TargetAssemblies =
        {
            "Game", "Core", "Common", "Base"
        };

        private static readonly string[] InterestingNames =
        {
            "GameApplication",
            "GameController",
            "LoadController",
            "OptionController",
            "RitePanelShowController",
            "RitePanelController",
            "ConfirmController",
            "DifficultyPanelController",
            "StoryNotifyController",
            "SudanBoxController",
            "BeginGuideController",
            "BeginGuideItemController",
            "BeginGuideButtonHandler",
            "CardSlotController",
            "Player",
            "Global",
            "Card",
            "Rite"
        };

        public static Dictionary<string, object> Probe()
        {
            var report = new Dictionary<string, object>
            {
                ["probedAt"] = DateTimeOffset.Now.ToString("o"),
                ["assemblyCount"] = 0,
                ["hits"] = new List<Dictionary<string, object>>(),
                ["errors"] = new List<string>(),
                ["hasInterop"] = GameBindings.HasInterop
            };

            try
            {
                var asms = AppDomain.CurrentDomain.GetAssemblies()
                    .Where(a =>
                    {
                        var name = a.GetName().Name ?? "";
                        return TargetAssemblies.Any(t =>
                            name.Equals(t, StringComparison.OrdinalIgnoreCase) ||
                            name.EndsWith("." + t, StringComparison.OrdinalIgnoreCase));
                    })
                    .ToArray();
                report["assemblyCount"] = asms.Length;
                var hits = (List<Dictionary<string, object>>)report["hits"];
                var errors = (List<string>)report["errors"];

                foreach (var asm in asms)
                {
                    Type[] types;
                    try
                    {
                        types = asm.GetTypes();
                    }
                    catch (ReflectionTypeLoadException ex)
                    {
                        types = ex.Types.Where(t => t != null).ToArray();
                        errors.Add(asm.GetName().Name + ": ReflectionTypeLoadException");
                    }
                    catch (Exception ex)
                    {
                        errors.Add(asm.GetName().Name + ": " + ex.GetType().Name);
                        continue;
                    }

                    foreach (var type in types)
                    {
                        if (type == null || string.IsNullOrEmpty(type.Name)) continue;
                        if (!InterestingNames.Any(n => type.Name.Equals(n, StringComparison.Ordinal)))
                        {
                            continue;
                        }
                        hits.Add(DescribeType(type));
                    }
                }

                report["hitCount"] = hits.Count;
                report["bindings"] = GameBindings.SnapshotBindings();
            }
            catch (Exception ex)
            {
                ((List<string>)report["errors"]).Add(ex.GetType().Name + ": " + ex.Message);
            }

            LastReport = report;
            return report;
        }

        private static Dictionary<string, object> DescribeType(Type type)
        {
            var props = type.GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static)
                .Take(40)
                .Select(p => p.PropertyType.Name + " " + p.Name +
                             (p.GetGetMethod() != null && p.GetGetMethod().IsStatic ? " [static]" : ""))
                .ToList();
            var methods = type.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly)
                .Where(m => !m.IsSpecialName)
                .Take(40)
                .Select(m =>
                {
                    var ps = string.Join(", ", m.GetParameters().Select(p => p.ParameterType.Name + " " + p.Name));
                    var prefix = m.IsStatic ? "static " : "";
                    return prefix + m.ReturnType.Name + " " + m.Name + "(" + ps + ")";
                })
                .ToList();

            object instanceHint = null;
            foreach (var name in new[] { "Inst", "Instance", "instance", "Current" })
            {
                try
                {
                    var prop = type.GetProperty(name, BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy);
                    if (prop != null)
                    {
                        instanceHint = "static_property:" + prop.Name;
                        break;
                    }
                    var field = type.GetField(name, BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy);
                    if (field != null)
                    {
                        instanceHint = "static_field:" + field.Name;
                        break;
                    }
                }
                catch
                {
                    // ignore
                }
            }

            return new Dictionary<string, object>
            {
                ["fullName"] = type.FullName,
                ["assembly"] = type.Assembly.GetName().Name,
                ["instanceHint"] = instanceHint,
                ["properties"] = props,
                ["methods"] = methods
            };
        }
    }
}
