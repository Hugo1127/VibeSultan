using System;
using System.Collections.Generic;
using System.Reflection;
#if GAME_INTEROP
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;
#endif

namespace VibeSultan.Sultan.Observer.State
{
    /// <summary>
    /// Generic overlay discovery for GameController PanelBase / active UI panels.
    /// Known panels get rich metadata; unknown active PanelBase panels are still reported.
    /// </summary>
    public static class OverlayScanner
    {
#if GAME_INTEROP
        public delegate void DismissHandler();
#endif

        public sealed class Overlay
        {
            public string id;
            public string kind;
            public bool blocking;
            public string dismissOp;
            public string text;
            public string source; // property name on GameController
#if GAME_INTEROP
            public Behaviour behaviour;
            public DismissHandler dismiss;
#endif
        }

#if GAME_INTEROP
        private static readonly HashSet<string> NonBlockingSources = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "ritePanel",
            "map",
            "mapController",
            "desktop",
            "hand",
            "handBagPanelController",
            "bagPanelController",
            "noteListController"
        };

        public static List<Overlay> Scan()
        {
            var list = new List<Overlay>();
            var controller = GameBindings.Controller;
            if (controller == null) return list;

            // Priority known overlays first (dismiss order / phase mapping).
            TryAddKnown(list, "change_name", "name_input", true, "continue",
                controller.promptChangeNameController, IsChangeNameActive, ReadChangeNameText,
                () => controller.promptChangeNameController?.OnConfirm());

            TryAddKnown(list, "prompt", "intro_or_tip", true, "continue",
                controller.promptController, () => GameBindings.IsPromptActive, () => GameBindings.ReadPromptText(),
                () => controller.promptController?.OnConfirm());

            // BeginGuide finger tutorial — never auto-dismiss (OnClose force-resolves).
            TryAddKnown(list, "begin_guide", "begin_guide", true, PreferredGuideDismissOp(),
                controller.beginGuideController,
                () => GameBindings.IsBeginGuideActive,
                ReadBeginGuideText,
                null);

            // Difficulty is an onboarding modal. The Sudan box can already be active
            // behind it, but must not become the top affordance until difficulty closes.
            TryAddKnown(list, "difficulty", "difficulty", true, "select_difficulty",
                controller.difficultyPanelController, () => GameBindings.IsUiActive(controller.difficultyPanelController), null,
                () => controller.difficultyPanelController?.OnConfirm());

            // WizardController is reused for real multi-option menus. When it owns
            // multiple interactable buttons it is the foreground choice surface,
            // not informational tutorial text behind the Sudan box.
            var wizardChoiceMenu = GameBindings.IsWizardChoiceMenu;
            if (wizardChoiceMenu)
            {
                TryAddKnown(list, "wizard", "wizard_choice", true, null,
                    controller.wizardController,
                    () => GameBindings.IsUiActive(controller.wizardController),
                    null,
                    null);
            }

            TryAddKnown(list, "option", "story_option", true, "select_event_option",
                controller.optionController, () => GameBindings.IsUiActive(controller.optionController), ReadOptionPrompt,
                // Bare OnConfirm without a selection is a no-op / soft lock on perk screens.
                null);

            TryAddKnown(list, "confirm", "confirm", true, "continue",
                controller.confirmController, () => GameBindings.IsUiActive(controller.confirmController), null,
                () => controller.confirmController?.OnConfirm());

            // Sudan-card break/reveal waits for blank click; often sits above a gray-Next result page.
            TryAddKnown(list, "sudan_breaker", "sudan_breaker", true, "continue",
                controller.SudanBreakerController,
                () => GameBindings.IsSudanBreakerWaiting,
                () => "苏丹卡折断/展示 — 点击空白继续",
                () =>
                {
                    GameBindings.TryClickSudanBreaker(out _);
                });

            TryAddKnown(list, "rite_result", "rite_result", true, "continue",
                controller.riteResultPanel, () => GameBindings.IsUiActive(controller.riteResultPanel),
                () =>
                {
                    var snap = GameBindings.ReadRiteResultSnapshot(160);
                    if (snap != null && snap.TryGetValue("summary", out var summary) && summary is string s
                        && !string.IsNullOrWhiteSpace(s))
                    {
                        return s;
                    }
                    return null;
                },
                () =>
                {
                    if (!TryDismissRiteResultNext())
                    {
                        // Do not OnClose the result panel — that can soft-lock the day.
                        GameBindings.TryAdvanceRiteResult(out _, out _);
                    }
                });

            // Draw-from-box has higher priority than wizard text: the tutorial asks the
            // player to click the metal Sudan box; wizard.OnConfirm will not draw.
            bool guideBlocksWizard = GameBindings.IsBeginGuideActive || GameBindings.IsSudanDrawBlocking;
            TryAddKnown(list, "sudan_box", "draw_sudan", true, "draw_sudan_card",
                GameBindings.FindSudanBoxController(),
                () => GameBindings.IsSudanDrawBlocking,
                () => GameBindings.ReadSudanBoxTips(),
                () => GameBindings.ClickSudanBox());

            // While guide/box waiting, wizard is informational only.
            if (!wizardChoiceMenu)
            {
                TryAddKnown(list, "wizard", "wizard", !guideBlocksWizard, "continue",
                    controller.wizardController, () => GameBindings.IsUiActive(controller.wizardController), null,
                    () => controller.wizardController?.OnConfirm());
            }

            TryAddKnown(list, "rite", "rite_panel", false, "start_rite",
                controller.ritePanel, () => GameBindings.IsUiActive(controller.ritePanel), null,
                () => controller.ritePanel?.OnConfirm());

            // Generic fallback: any other active PanelBase on GameController.
            ScanUnknownPanelBase(list, controller);
            return list;
        }

        public static Overlay TopBlocking(List<Overlay> overlays = null)
        {
            overlays ??= Scan();
            foreach (var o in overlays)
            {
                if (o != null && o.blocking) return o;
            }
            return null;
        }

        public static bool HasBlocking(List<Overlay> overlays = null)
        {
            return TopBlocking(overlays) != null;
        }

        public static string DismissTopBlocking(List<Overlay> overlays = null)
        {
            var top = TopBlocking(overlays);
            if (top == null) return null;
            try
            {
                top.dismiss?.Invoke();
                return top.source ?? top.id;
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException("dismiss_" + top.id + ": " + ex.Message, ex);
            }
        }

        private static bool IsChangeNameActive()
        {
            var panel = GameBindings.Controller?.promptChangeNameController;
            if (panel == null) return false;
            if (GameBindings.IsUiActive(panel)) return true;
            try
            {
                var input = panel.Input;
                if (input != null && input.gameObject != null && input.gameObject.activeInHierarchy)
                {
                    return true;
                }
                var prompt = panel.Prompt;
                if (prompt != null && prompt.gameObject != null && prompt.gameObject.activeInHierarchy)
                {
                    return true;
                }
            }
            catch
            {
                // ignore
            }
            return false;
        }

        private static string ReadChangeNameText()
        {
            try
            {
                var input = GameBindings.Controller?.promptChangeNameController?.Input;
                var text = input?.text;
                if (string.IsNullOrEmpty(text)) return null;
                return text.Trim();
            }
            catch
            {
                return null;
            }
        }

        private static string ReadOptionPrompt()
        {
            try
            {
                var text = GameBindings.OptionPanel?.Content?.text;
                if (string.IsNullOrEmpty(text)) return null;
                text = text.Replace("\r", " ").Replace("\n", " ").Trim();
                if (text.Length > 160) text = text.Substring(0, 160) + "…";
                return text;
            }
            catch
            {
                return null;
            }
        }

        private static string ReadBeginGuideText()
        {
            try
            {
                var snap = GameBindings.ReadBeginGuideSnapshot();
                if (snap == null) return null;
                var type = snap.TryGetValue("type", out var t) ? t as string : null;
                var text = snap.TryGetValue("text", out var tx) ? tx as string : null;
                var hint = snap.TryGetValue("hint", out var h) ? h as string : null;
                if (!string.IsNullOrEmpty(text)) return text;
                if (!string.IsNullOrEmpty(type) && !string.IsNullOrEmpty(hint)) return type + ": " + hint;
                return type ?? hint;
            }
            catch
            {
                return null;
            }
        }

        private static string PreferredGuideDismissOp()
        {
            try
            {
                var snap = GameBindings.ReadBeginGuideSnapshot();
                if (snap != null
                    && snap.TryGetValue("preferredOp", out var preferred)
                    && preferred is string op
                    && !string.IsNullOrWhiteSpace(op))
                {
                    return op;
                }

                // Do not invent draw_sudan_card — a wrong dismissOp misleads the agent
                // into calling a disabled action during RITE_STOP / other guides.
                return null;
            }
            catch
            {
                return null;
            }
        }

        private static void TryAddKnown(
            List<Overlay> list,
            string id,
            string kind,
            bool blocking,
            string dismissOp,
            Behaviour behaviour,
            System.Func<bool> isActive,
            System.Func<string> readText,
            DismissHandler dismiss)
        {
            try
            {
                if (isActive == null || !isActive()) return;
            }
            catch
            {
                return;
            }

            string text = null;
            try { text = readText?.Invoke(); } catch { /* optional */ }

            list.Add(new Overlay
            {
                id = id,
                kind = kind,
                blocking = blocking,
                dismissOp = dismissOp,
                text = text,
                source = id,
                behaviour = behaviour,
                dismiss = dismiss
            });
        }

        private static void ScanUnknownPanelBase(List<Overlay> list, GameController controller)
        {
            var known = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var o in list)
            {
                if (!string.IsNullOrEmpty(o.source)) known.Add(o.source);
                if (!string.IsNullOrEmpty(o.id)) known.Add(o.id);
            }

            // Map property names we already covered.
            known.Add("promptChangeNameController");
            known.Add("promptController");
            known.Add("wizardController");
            known.Add("confirmController");
            known.Add("difficultyPanelController");
            known.Add("optionController");
            known.Add("ritePanel");
            known.Add("riteResultPanel");
            known.Add("SudanBreakerController");
            known.Add("sudan_breaker");
            known.Add("SudanBox");
            known.Add("sudan_box");
            known.Add("beginGuideController");
            known.Add("begin_guide");

            PropertyInfo[] props;
            try
            {
                props = typeof(GameController).GetProperties(BindingFlags.Public | BindingFlags.Instance);
            }
            catch
            {
                return;
            }

            foreach (var prop in props)
            {
                if (prop == null || known.Contains(prop.Name)) continue;
                if (prop.GetIndexParameters().Length > 0) continue;
                if (!typeof(Behaviour).IsAssignableFrom(prop.PropertyType)) continue;
                // Prefer PanelBase-looking types by name to avoid scanning cameras/transforms.
                var typeName = prop.PropertyType.Name ?? "";
                if (!(typeName.IndexOf("Panel", StringComparison.OrdinalIgnoreCase) >= 0
                      || typeName.IndexOf("Prompt", StringComparison.OrdinalIgnoreCase) >= 0
                      || typeName.IndexOf("Controller", StringComparison.OrdinalIgnoreCase) >= 0
                      || typeof(PanelBase).IsAssignableFrom(prop.PropertyType)))
                {
                    continue;
                }

                Behaviour behaviour;
                try { behaviour = prop.GetValue(controller) as Behaviour; }
                catch { continue; }
                if (!GameBindings.IsUiActive(behaviour)) continue;

                bool blocking = !NonBlockingSources.Contains(prop.Name);
                var id = ToOverlayId(prop.Name);
                list.Add(new Overlay
                {
                    id = id,
                    kind = "panel",
                    blocking = blocking,
                    dismissOp = "continue",
                    text = null,
                    source = prop.Name,
                    behaviour = behaviour,
                    dismiss = new DismissHandler(() => TryInvokeConfirmOrClose(behaviour))
                });
            }
        }

        private static string ToOverlayId(string propertyName)
        {
            if (string.IsNullOrEmpty(propertyName)) return "panel";
            var name = propertyName;
            if (name.EndsWith("Controller", StringComparison.OrdinalIgnoreCase))
            {
                name = name.Substring(0, name.Length - "Controller".Length);
            }
            if (name.EndsWith("Panel", StringComparison.OrdinalIgnoreCase))
            {
                name = name.Substring(0, name.Length - "Panel".Length);
            }
            // camelCase -> snake-ish
            var chars = new List<char>();
            for (int i = 0; i < name.Length; i++)
            {
                var c = name[i];
                if (i > 0 && char.IsUpper(c)) chars.Add('_');
                chars.Add(char.ToLowerInvariant(c));
            }
            return new string(chars.ToArray());
        }

        private static void TryInvokeConfirmOrClose(Behaviour behaviour)
        {
            if (behaviour == null) return;
            var type = behaviour.GetType();
            foreach (var methodName in new[] { "OnConfirm", "OnClose", "Hide", "Close" })
            {
                try
                {
                    var method = type.GetMethod(methodName, BindingFlags.Public | BindingFlags.Instance, null, Type.EmptyTypes, null);
                    if (method == null) continue;
                    method.Invoke(behaviour, null);
                    return;
                }
                catch
                {
                    // try next
                }
            }
        }

        /// <summary>
        /// Rite result pages: Next when ready; otherwise click body text to roll/advance.
        /// Never force-click a disabled Next (that previously reported false success).
        /// </summary>
        public static bool TryDismissRiteResultNext()
        {
            return GameBindings.TryAdvanceRiteResult(out _, out _);
        }

        public static bool TryClickNamedButton(Transform root, string name, bool requireInteractable = true)
        {
            if (root == null || string.IsNullOrEmpty(name)) return false;
            var go = FindDescendant(root, name);
            if (go == null || !go.activeInHierarchy) return false;

            try
            {
                var button = go.GetComponent<Button>();
                if (button != null)
                {
                    if (requireInteractable && !button.IsInteractable()) return false;
                    if (button.IsInteractable())
                    {
                        button.onClick.Invoke();
                        return true;
                    }

                    // Non-interactable Button: still allow pointer path when not required.
                    if (requireInteractable) return false;
                }
                else if (requireInteractable)
                {
                    return false;
                }

                var eventSystem = EventSystem.current;
                if (eventSystem == null) return false;
                var rect = go.GetComponent<RectTransform>();
                var pointer = new PointerEventData(eventSystem);
                if (rect != null)
                {
                    Camera cam = null;
                    // Avoid GetComponentInParent<Canvas> (Il2Cpp Cast VerificationException).
                    var t = rect.transform;
                    for (var i = 0; i < 12 && t != null; i++)
                    {
                        var canvas = t.GetComponent<Canvas>();
                        if (canvas != null && canvas.renderMode != RenderMode.ScreenSpaceOverlay)
                        {
                            cam = canvas.worldCamera != null ? canvas.worldCamera : Camera.main;
                            break;
                        }

                        t = t.parent;
                    }

                    pointer.position = RectTransformUtility.WorldToScreenPoint(cam, rect.position);
                }

                ExecuteEvents.Execute(go, pointer, ExecuteEvents.pointerClickHandler);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static GameObject FindDescendant(Transform root, string name)
        {
            if (root == null) return null;
            var queue = new Queue<Transform>();
            queue.Enqueue(root);
            while (queue.Count > 0)
            {
                var current = queue.Dequeue();
                if (current != null && string.Equals(current.name, name, StringComparison.OrdinalIgnoreCase))
                {
                    return current.gameObject;
                }

                if (current == null) continue;
                for (var i = 0; i < current.childCount; i++)
                {
                    queue.Enqueue(current.GetChild(i));
                }
            }

            return null;
        }
#else
        public static List<Overlay> Scan() => new List<Overlay>();
        public static Overlay TopBlocking(List<Overlay> overlays = null) => null;
        public static bool HasBlocking(List<Overlay> overlays = null) => false;
        public static string DismissTopBlocking() => null;
        public static bool TryDismissRiteResultNext() => false;
        public static bool TryClickNamedButton(object root, string name, bool requireInteractable = true) => false;
#endif
    }
}
