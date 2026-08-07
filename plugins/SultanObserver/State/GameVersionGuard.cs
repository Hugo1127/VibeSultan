using System;
using System.IO;
using UnityEngine;

namespace VibeSultan.Sultan.Observer.State
{
    /// <summary>
    /// Tracks a simple game fingerprint so dangerous actions can be disabled after updates.
    /// </summary>
    public sealed class GameVersionGuard
    {
        public const string ExpectedUnity = "2022.3.62f2";

        public bool IsSafe { get; private set; } = true;
        public string Detail { get; private set; } = "ok";
        public string Fingerprint { get; private set; } = "unknown";

        public void Refresh()
        {
            try
            {
                var unity = Application.unityVersion ?? "";
                var product = Application.productName ?? "";
                var ga = Path.Combine(Application.dataPath, "..", "GameAssembly.dll");
                long gaSize = File.Exists(ga) ? new FileInfo(ga).Length : -1;
                Fingerprint = unity + "|" + product + "|" + gaSize;

                if (!unity.StartsWith("2022.3.62", StringComparison.Ordinal))
                {
                    IsSafe = false;
                    Detail = "unexpected_unity_version:" + unity + "; regenerate interop and re-smoke";
                    return;
                }

                if (!string.Equals(product, "Sultan's Game", StringComparison.OrdinalIgnoreCase) &&
                    !string.IsNullOrEmpty(product) &&
                    product.IndexOf("Sultan", StringComparison.OrdinalIgnoreCase) < 0)
                {
                    IsSafe = false;
                    Detail = "unexpected_product:" + product;
                    return;
                }

                IsSafe = true;
                Detail = "ok";
            }
            catch (Exception ex)
            {
                IsSafe = false;
                Detail = "fingerprint_error:" + ex.Message;
            }
        }
    }
}
