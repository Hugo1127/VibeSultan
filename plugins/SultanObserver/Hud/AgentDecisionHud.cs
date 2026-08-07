using System;
using System.Text;
using UnityEngine;
using VibeSultan.Sultan.Observer.Export;

namespace VibeSultan.Sultan.Observer.Hud
{
    public sealed class AgentDecisionHud : MonoBehaviour
    {
        private const float HorizontalPadding = 12f;
        private const float StatusHeight = 38f;
        // Keep clear of top game UI (approx. 5 lines of HUD body text).
        private const float TopMargin = 5f * 18f;
        private GUIStyle _panelStyle;
        private GUIStyle _titleStyle;
        private GUIStyle _bodyStyle;
        private GUIStyle _statusStyle;
        private Texture2D _panelTexture;
        private Texture2D _statusTexture;

        public AgentDecisionHud(IntPtr ptr) : base(ptr)
        {
        }

        public void Awake()
        {
            DontDestroyOnLoad(gameObject);
        }

        public void OnGUI()
        {
            EnsureStyles();

            var items = AgentDecisionBoard.Instance.Snapshot();
            float y = TopMargin;
            float width = Screen.width < 1200 ? Screen.width * 0.46f : 440f;
            foreach (var item in items)
            {
                var decision = item.decision;
                if (decision == null)
                {
                    continue;
                }

                var body = new StringBuilder();
                if (!string.IsNullOrEmpty(decision.thinking))
                {
                    body.Append("Think: ");
                    body.AppendLine(decision.thinking);
                }
                if (!string.IsNullOrEmpty(decision.goal)) body.AppendLine(decision.goal);
                if (!string.IsNullOrEmpty(decision.why)) body.AppendLine(decision.why);
                if (decision.actions != null && decision.actions.Count > 0)
                {
                    body.Append("Actions: ");
                    body.Append(string.Join(" · ", decision.actions));
                }

                var bodyText = body.ToString().TrimEnd();
                var bodyHeight = string.IsNullOrEmpty(bodyText)
                    ? 0f
                    : EstimateTextHeight(bodyText, width - HorizontalPadding * 2f);
                var height = 12f + 22f + (bodyHeight > 0f ? bodyHeight + 4f : 0f) + StatusHeight + 8f;
                var rect = new Rect(Screen.width - width - 12f, y, width, height);
                GUI.Box(rect, string.Empty, _panelStyle);

                var contentX = rect.x + HorizontalPadding;
                var contentWidth = rect.width - HorizontalPadding * 2f;
                GUI.Label(
                    new Rect(contentX, rect.y + 9f, contentWidth, 22f),
                    decision.title ?? "(decision)",
                    _titleStyle);
                if (bodyHeight > 0f)
                {
                    GUI.Label(
                        new Rect(contentX, rect.y + 33f, contentWidth, bodyHeight),
                        bodyText,
                        _bodyStyle);
                }

                var statusRect = new Rect(
                    rect.x + 1f,
                    rect.y + rect.height - StatusHeight - 1f,
                    rect.width - 2f,
                    StatusHeight);
                GUI.Label(statusRect, FormatStatus(item.stats), _statusStyle);
                y += height + 8f;
            }
        }

        private void EnsureStyles()
        {
            if (_panelStyle != null)
            {
                return;
            }

            _panelTexture = CreateTexture(new Color(0.055f, 0.065f, 0.08f, 0.92f));
            _statusTexture = CreateTexture(new Color(0.025f, 0.03f, 0.04f, 0.96f));

            _panelStyle = new GUIStyle()
            {
                alignment = TextAnchor.UpperLeft,
                padding = new RectOffset(0, 0, 0, 0),
            };
            _panelStyle.normal.background = _panelTexture;

            _titleStyle = new GUIStyle()
            {
                alignment = TextAnchor.UpperLeft,
                fontStyle = FontStyle.Bold,
                fontSize = 14,
                wordWrap = true,
            };
            _titleStyle.normal.textColor = new Color(0.94f, 0.97f, 1f, 1f);

            _bodyStyle = new GUIStyle()
            {
                alignment = TextAnchor.UpperLeft,
                fontSize = 13,
                wordWrap = true,
            };
            _bodyStyle.normal.textColor = new Color(0.85f, 0.89f, 0.94f, 1f);

            _statusStyle = new GUIStyle()
            {
                alignment = TextAnchor.UpperLeft,
                fontSize = 11,
                wordWrap = true,
                padding = new RectOffset(11, 11, 4, 3),
            };
            _statusStyle.normal.background = _statusTexture;
            _statusStyle.normal.textColor = new Color(0.65f, 0.78f, 0.9f, 1f);
        }

        private static Texture2D CreateTexture(Color color)
        {
            var texture = new Texture2D(1, 1);
            texture.SetPixel(0, 0, color);
            texture.Apply();
            return texture;
        }

        private static float EstimateTextHeight(string text, float width)
        {
            var charactersPerLine = Math.Max(20, (int)(width / 7f));
            var lines = 0;
            foreach (var line in text.Split('\n'))
            {
                lines += Math.Max(1, (int)Math.Ceiling((double)line.Length / charactersPerLine));
            }

            return lines * 18f;
        }

        private static string FormatStatus(AgentLlmStatsDto stats)
        {
            if (stats == null)
            {
                return "Waiting for LLM metrics...";
            }

            var firstLine =
                $"STEP {FormatInteger(stats.step)} | TOKENS {FormatInteger(stats.totalTokens)} | " +
                $"IN {FormatInteger(stats.prefillTokens)} | OUT {FormatInteger(stats.decodeTokens)}";
            var secondLine =
                $"TIME {FormatDuration(stats.elapsedMs)} | TTFT {FormatDuration(stats.firstTokenMs)} | " +
                $"SPEED {FormatRate(stats.decodeTokPerSec)}";
            return firstLine + "\n" + secondLine;
        }

        private static string FormatInteger(int? value)
        {
            return value.HasValue ? value.Value.ToString("N0") : "-";
        }

        private static string FormatDuration(int? milliseconds)
        {
            if (!milliseconds.HasValue)
            {
                return "-";
            }

            return milliseconds.Value < 1000
                ? $"{milliseconds.Value}ms"
                : $"{milliseconds.Value / 1000d:0.0}s";
        }

        private static string FormatRate(double? tokensPerSecond)
        {
            return tokensPerSecond.HasValue ? $"{tokensPerSecond.Value:0.0} tok/s" : "-";
        }
    }
}
