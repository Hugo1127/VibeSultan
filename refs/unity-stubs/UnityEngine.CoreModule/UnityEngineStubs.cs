// Compile-time stubs for the slice of the Unity API that SultanObserver uses
// when no BepInEx/interop assemblies exist. This assembly is never shipped and
// never loaded at runtime: once BepInEx generates interop DLLs, the plugin
// compiles against the real UnityEngine.CoreModule instead.
//
// Keep the shapes (base types, constructor signatures, member names) close to
// Il2CppInterop-generated assemblies so `#if GAME_INTEROP` code behaves the same
// way in both configurations.
using System;
using System.Collections;
using System.Collections.Generic;

namespace UnityEngine
{
    public class Object
    {
        protected Object()
        {
        }

        protected Object(IntPtr pointer)
        {
        }

        public string name { get; set; }
        public HideFlags hideFlags { get; set; }

        public int GetInstanceID() => 0;
        public override string ToString() => name ?? base.ToString();

        public static void Destroy(Object obj) { }
        public static void Destroy(Object obj, float t) { }
        public static void DestroyImmediate(Object obj) { }
        public static void DestroyImmediate(Object obj, bool allowDestroyingAssets) { }
        public static void DontDestroyOnLoad(Object target) { }

        public static T Instantiate<T>(T original) where T : Object => original;
        public static Object Instantiate(Object original) => original;

        public static T FindObjectOfType<T>() where T : Object => null;
        public static T FindObjectOfType<T>(bool includeInactive) where T : Object => null;
        public static Object FindObjectOfType(Type type) => null;

        public static T[] FindObjectsOfType<T>() where T : Object => Array.Empty<T>();
        public static T[] FindObjectsOfType<T>(bool includeInactive) where T : Object => Array.Empty<T>();
        public static Object[] FindObjectsOfType(Type type) => Array.Empty<Object>();

        public static T[] FindObjectsByType<T>(FindObjectsSortMode sortMode) where T : Object => Array.Empty<T>();
        public static T[] FindObjectsByType<T>(FindObjectsInactive inactive, FindObjectsSortMode sortMode) where T : Object
            => Array.Empty<T>();

        public static bool operator ==(Object x, Object y) => ReferenceEquals(x, y);
        public static bool operator !=(Object x, Object y) => !ReferenceEquals(x, y);
        public static implicit operator bool(Object exists) => !ReferenceEquals(exists, null);

        public override bool Equals(object other) => ReferenceEquals(this, other);
        public override int GetHashCode() => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(this);
    }

    public enum FindObjectsInactive { Exclude, Include }
    public enum FindObjectsSortMode { None, InstanceID }

    [Flags]
    public enum HideFlags
    {
        None = 0,
        HideInHierarchy = 1,
        HideInInspector = 2,
        DontSaveInEditor = 4,
        NotEditable = 8,
        DontSaveInBuild = 16,
        DontUnloadUnusedAsset = 32,
        DontSave = 52,
        HideAndDontSave = 61
    }

    public class Component : Object
    {
        protected Component(IntPtr pointer) : base(pointer)
        {
        }

        public GameObject gameObject => null;
        public Transform transform => null;
        public string tag { get; set; }

        public T GetComponent<T>() => default;
        public Component GetComponent(Type type) => null;
        public Component GetComponent(string type) => null;

        public T GetComponentInChildren<T>() => default;
        public T GetComponentInChildren<T>(bool includeInactive) => default;
        public T GetComponentInParent<T>() => default;

        public T[] GetComponents<T>() => Array.Empty<T>();
        public Component[] GetComponents(Type type) => Array.Empty<Component>();
        public T[] GetComponentsInChildren<T>() => Array.Empty<T>();
        public T[] GetComponentsInChildren<T>(bool includeInactive) => Array.Empty<T>();
        public T[] GetComponentsInParent<T>() => Array.Empty<T>();

        public bool TryGetComponent<T>(out T component)
        {
            component = default;
            return false;
        }

        public bool CompareTag(string tag) => false;
    }

    public class Behaviour : Component
    {
        protected Behaviour(IntPtr pointer) : base(pointer)
        {
        }

        public bool enabled { get; set; }
        public bool isActiveAndEnabled => false;
    }

    public class MonoBehaviour : Behaviour
    {
        public MonoBehaviour(IntPtr pointer) : base(pointer)
        {
        }

        public bool useGUILayout { get; set; }
        public bool runInEditMode { get; set; }

        public Coroutine StartCoroutine(IEnumerator routine) => null;
        public Coroutine StartCoroutine(string methodName) => null;
        public void StopCoroutine(IEnumerator routine) { }
        public void StopCoroutine(Coroutine routine) { }
        public void StopAllCoroutines() { }
        public void Invoke(string methodName, float time) { }
        public void CancelInvoke() { }
        public bool IsInvoking(string methodName) => false;
        public static void print(object message) { }
    }

    public class ScriptableObject : Object
    {
        protected ScriptableObject(IntPtr pointer) : base(pointer)
        {
        }

        public static T CreateInstance<T>() where T : ScriptableObject => null;
    }

    public sealed class Coroutine : YieldInstruction
    {
        public Coroutine(IntPtr pointer) : base(pointer)
        {
        }
    }

    public class YieldInstruction : Object
    {
        protected YieldInstruction(IntPtr pointer) : base(pointer)
        {
        }
    }

    public sealed class WaitForSeconds : YieldInstruction
    {
        public WaitForSeconds(float seconds) : base(IntPtr.Zero) { }
    }

    public sealed class WaitForEndOfFrame : YieldInstruction
    {
        public WaitForEndOfFrame() : base(IntPtr.Zero) { }
    }

    public class GameObject : Object
    {
        public GameObject() : base(IntPtr.Zero) { }
        public GameObject(string name) : base(IntPtr.Zero) { }
        public GameObject(string name, params Type[] components) : base(IntPtr.Zero) { }

        public Transform transform => null;
        public int layer { get; set; }
        public bool activeSelf => false;
        public bool activeInHierarchy => false;
        public bool isStatic { get; set; }
        public string tag { get; set; }

        public void SetActive(bool value) { }

        public T AddComponent<T>() where T : Component => null;
        public Component AddComponent(Type componentType) => null;

        public T GetComponent<T>() => default;
        public Component GetComponent(Type type) => null;
        public Component GetComponent(string type) => null;

        public T GetComponentInChildren<T>() => default;
        public T GetComponentInChildren<T>(bool includeInactive) => default;
        public T GetComponentInParent<T>() => default;
        public T[] GetComponentsInChildren<T>() => Array.Empty<T>();
        public T[] GetComponentsInChildren<T>(bool includeInactive) => Array.Empty<T>();

        public static GameObject Find(string name) => null;
        public static GameObject FindWithTag(string tag) => null;
        public static GameObject[] FindGameObjectsWithTag(string tag) => Array.Empty<GameObject>();
        public static GameObject CreatePrimitive(PrimitiveType type) => null;
    }

    public enum PrimitiveType { Sphere, Capsule, Cylinder, Cube, Plane, Quad }

    public class Transform : Component, IEnumerable
    {
        protected Transform(IntPtr pointer) : base(pointer)
        {
        }

        public Transform parent { get; set; }
        public Transform root => null;
        public int childCount => 0;
        public Vector3 position { get; set; }
        public Vector3 localPosition { get; set; }
        public Vector3 localScale { get; set; }
        public Vector3 lossyScale => default;
        public Vector3 eulerAngles { get; set; }
        public Vector3 localEulerAngles { get; set; }
        public Quaternion rotation { get; set; }
        public Quaternion localRotation { get; set; }
        public bool hasChanged { get; set; }

        public Transform GetChild(int index) => null;
        public Transform Find(string n) => null;
        public void SetParent(Transform p) { }
        public void SetParent(Transform p, bool worldPositionStays) { }
        public void SetAsLastSibling() { }
        public void SetAsFirstSibling() { }
        public void SetSiblingIndex(int index) { }
        public int GetSiblingIndex() => 0;
        public void DetachChildren() { }
        public void Translate(Vector3 translation) { }
        public void Rotate(Vector3 eulers) { }
        public Vector3 TransformPoint(Vector3 position) => position;

        public IEnumerator GetEnumerator()
        {
            yield break;
        }
    }

    public class RectTransform : Transform
    {
        protected RectTransform(IntPtr pointer) : base(pointer)
        {
        }

        public Rect rect => default;
        public Vector2 anchoredPosition { get; set; }
        public Vector3 anchoredPosition3D { get; set; }
        public Vector2 sizeDelta { get; set; }
        public Vector2 pivot { get; set; }
        public Vector2 anchorMin { get; set; }
        public Vector2 anchorMax { get; set; }
        public Vector2 offsetMin { get; set; }
        public Vector2 offsetMax { get; set; }
    }

    public class Canvas : Behaviour
    {
        protected Canvas(IntPtr pointer) : base(pointer)
        {
        }

        public RenderMode renderMode { get; set; }
        public int sortingOrder { get; set; }
        public bool overrideSorting { get; set; }
        public float scaleFactor => 1f;
        public Canvas rootCanvas => null;
    }

    public enum RenderMode { ScreenSpaceOverlay, ScreenSpaceCamera, WorldSpace }

    public class CanvasGroup : Behaviour
    {
        protected CanvasGroup(IntPtr pointer) : base(pointer)
        {
        }

        public float alpha { get; set; }
        public bool interactable { get; set; }
        public bool blocksRaycasts { get; set; }
        public bool ignoreParentGroups { get; set; }
    }

    public struct Vector2
    {
        public float x;
        public float y;

        public Vector2(float x, float y)
        {
            this.x = x;
            this.y = y;
        }

        public static Vector2 zero => new Vector2(0f, 0f);
        public static Vector2 one => new Vector2(1f, 1f);
        public static Vector2 up => new Vector2(0f, 1f);
        public static Vector2 down => new Vector2(0f, -1f);
        public static Vector2 left => new Vector2(-1f, 0f);
        public static Vector2 right => new Vector2(1f, 0f);

        public float magnitude => 0f;
        public float sqrMagnitude => 0f;
        public Vector2 normalized => this;

        public static float Distance(Vector2 a, Vector2 b) => 0f;
        public static Vector2 Lerp(Vector2 a, Vector2 b, float t) => a;

        public static Vector2 operator +(Vector2 a, Vector2 b) => new Vector2(a.x + b.x, a.y + b.y);
        public static Vector2 operator -(Vector2 a, Vector2 b) => new Vector2(a.x - b.x, a.y - b.y);
        public static Vector2 operator *(Vector2 a, float d) => new Vector2(a.x * d, a.y * d);
        public static Vector2 operator /(Vector2 a, float d) => new Vector2(a.x / d, a.y / d);
        public static bool operator ==(Vector2 a, Vector2 b) => a.x == b.x && a.y == b.y;
        public static bool operator !=(Vector2 a, Vector2 b) => !(a == b);

        public override bool Equals(object other) => other is Vector2 v && this == v;
        public override int GetHashCode() => x.GetHashCode() ^ y.GetHashCode();
        public override string ToString() => $"({x}, {y})";
    }

    public struct Vector3
    {
        public float x;
        public float y;
        public float z;

        public Vector3(float x, float y)
        {
            this.x = x;
            this.y = y;
            z = 0f;
        }

        public Vector3(float x, float y, float z)
        {
            this.x = x;
            this.y = y;
            this.z = z;
        }

        public static Vector3 zero => new Vector3(0f, 0f, 0f);
        public static Vector3 one => new Vector3(1f, 1f, 1f);
        public static Vector3 up => new Vector3(0f, 1f, 0f);
        public static Vector3 down => new Vector3(0f, -1f, 0f);
        public static Vector3 forward => new Vector3(0f, 0f, 1f);
        public static Vector3 back => new Vector3(0f, 0f, -1f);
        public static Vector3 left => new Vector3(-1f, 0f, 0f);
        public static Vector3 right => new Vector3(1f, 0f, 0f);

        public float magnitude => 0f;
        public float sqrMagnitude => 0f;
        public Vector3 normalized => this;

        public static float Distance(Vector3 a, Vector3 b) => 0f;
        public static Vector3 Lerp(Vector3 a, Vector3 b, float t) => a;

        public static Vector3 operator +(Vector3 a, Vector3 b) => new Vector3(a.x + b.x, a.y + b.y, a.z + b.z);
        public static Vector3 operator -(Vector3 a, Vector3 b) => new Vector3(a.x - b.x, a.y - b.y, a.z - b.z);
        public static Vector3 operator -(Vector3 a) => new Vector3(-a.x, -a.y, -a.z);
        public static Vector3 operator *(Vector3 a, float d) => new Vector3(a.x * d, a.y * d, a.z * d);
        public static Vector3 operator /(Vector3 a, float d) => new Vector3(a.x / d, a.y / d, a.z / d);
        public static bool operator ==(Vector3 a, Vector3 b) => a.x == b.x && a.y == b.y && a.z == b.z;
        public static bool operator !=(Vector3 a, Vector3 b) => !(a == b);

        public override bool Equals(object other) => other is Vector3 v && this == v;
        public override int GetHashCode() => x.GetHashCode() ^ y.GetHashCode() ^ z.GetHashCode();
        public override string ToString() => $"({x}, {y}, {z})";
    }

    public struct Vector4
    {
        public float x;
        public float y;
        public float z;
        public float w;

        public Vector4(float x, float y, float z, float w)
        {
            this.x = x;
            this.y = y;
            this.z = z;
            this.w = w;
        }

        public static Vector4 zero => new Vector4(0f, 0f, 0f, 0f);
    }

    public struct Quaternion
    {
        public float x;
        public float y;
        public float z;
        public float w;

        public Quaternion(float x, float y, float z, float w)
        {
            this.x = x;
            this.y = y;
            this.z = z;
            this.w = w;
        }

        public static Quaternion identity => new Quaternion(0f, 0f, 0f, 1f);
        public static Quaternion Euler(float x, float y, float z) => identity;
        public static Quaternion Euler(Vector3 euler) => identity;
        public Vector3 eulerAngles => default;
    }

    public struct Color
    {
        public float r;
        public float g;
        public float b;
        public float a;

        public Color(float r, float g, float b)
        {
            this.r = r;
            this.g = g;
            this.b = b;
            a = 1f;
        }

        public Color(float r, float g, float b, float a)
        {
            this.r = r;
            this.g = g;
            this.b = b;
            this.a = a;
        }

        public static Color white => new Color(1f, 1f, 1f, 1f);
        public static Color black => new Color(0f, 0f, 0f, 1f);
        public static Color clear => new Color(0f, 0f, 0f, 0f);
        public static Color red => new Color(1f, 0f, 0f, 1f);
        public static Color green => new Color(0f, 1f, 0f, 1f);
        public static Color blue => new Color(0f, 0f, 1f, 1f);
        public static Color yellow => new Color(1f, 0.92f, 0.016f, 1f);
        public static Color gray => new Color(0.5f, 0.5f, 0.5f, 1f);
        public static Color grey => gray;

        public static Color Lerp(Color a, Color b, float t) => a;
        public static Color operator *(Color a, Color b) => new Color(a.r * b.r, a.g * b.g, a.b * b.b, a.a * b.a);
        public static Color operator *(Color a, float d) => new Color(a.r * d, a.g * d, a.b * d, a.a * d);
        public static implicit operator Color32(Color c) =>
            new Color32((byte)(c.r * 255f), (byte)(c.g * 255f), (byte)(c.b * 255f), (byte)(c.a * 255f));
    }

    public struct Color32
    {
        public byte r;
        public byte g;
        public byte b;
        public byte a;

        public Color32(byte r, byte g, byte b, byte a)
        {
            this.r = r;
            this.g = g;
            this.b = b;
            this.a = a;
        }

        public static implicit operator Color(Color32 c) =>
            new Color(c.r / 255f, c.g / 255f, c.b / 255f, c.a / 255f);
    }

    public struct Rect
    {
        private float m_XMin;
        private float m_YMin;
        private float m_Width;
        private float m_Height;

        public Rect(float x, float y, float width, float height)
        {
            m_XMin = x;
            m_YMin = y;
            m_Width = width;
            m_Height = height;
        }

        public Rect(Vector2 position, Vector2 size)
            : this(position.x, position.y, size.x, size.y)
        {
        }

        public float x
        {
            get => m_XMin;
            set => m_XMin = value;
        }

        public float y
        {
            get => m_YMin;
            set => m_YMin = value;
        }

        public float width
        {
            get => m_Width;
            set => m_Width = value;
        }

        public float height
        {
            get => m_Height;
            set => m_Height = value;
        }

        public Vector2 position
        {
            get => new Vector2(m_XMin, m_YMin);
            set
            {
                m_XMin = value.x;
                m_YMin = value.y;
            }
        }

        public Vector2 size
        {
            get => new Vector2(m_Width, m_Height);
            set
            {
                m_Width = value.x;
                m_Height = value.y;
            }
        }

        public Vector2 center => new Vector2(m_XMin + m_Width / 2f, m_YMin + m_Height / 2f);
        public Vector2 min => new Vector2(m_XMin, m_YMin);
        public Vector2 max => new Vector2(m_XMin + m_Width, m_YMin + m_Height);

        public float xMin
        {
            get => m_XMin;
            set => m_XMin = value;
        }

        public float yMin
        {
            get => m_YMin;
            set => m_YMin = value;
        }

        public float xMax => m_XMin + m_Width;

        public float yMax => m_YMin + m_Height;

        public bool Contains(Vector2 point) => false;
        public bool Contains(Vector3 point) => false;
        public bool Overlaps(Rect other) => false;

        public override string ToString() => $"({m_XMin}, {m_YMin}, {m_Width}, {m_Height})";
    }

    public struct RectInt
    {
        public int x;
        public int y;
        public int width;
        public int height;

        public RectInt(int x, int y, int width, int height)
        {
            this.x = x;
            this.y = y;
            this.width = width;
            this.height = height;
        }
    }

    public struct Bounds
    {
        public Bounds(Vector3 center, Vector3 size)
        {
            this.center = center;
            this.size = size;
        }

        public Vector3 center { get; set; }
        public Vector3 size { get; set; }
        public Vector3 extents => default;
        public Vector3 min => default;
        public Vector3 max => default;
        public bool Contains(Vector3 point) => false;
    }

    public struct RangeInt
    {
        public int start;
        public int length;

        public RangeInt(int start, int length)
        {
            this.start = start;
            this.length = length;
        }

        public int end => start + length;
    }

    public static class Mathf
    {
        public const float PI = 3.14159274f;
        public const float Infinity = float.PositiveInfinity;
        public const float NegativeInfinity = float.NegativeInfinity;
        public const float Deg2Rad = 0.0174532924f;
        public const float Rad2Deg = 57.29578f;
        public static readonly float Epsilon = float.Epsilon;

        public static float Abs(float f) => Math.Abs(f);
        public static int Abs(int value) => Math.Abs(value);
        public static float Min(float a, float b) => Math.Min(a, b);
        public static int Min(int a, int b) => Math.Min(a, b);
        public static float Max(float a, float b) => Math.Max(a, b);
        public static int Max(int a, int b) => Math.Max(a, b);
        public static float Clamp(float value, float min, float max) => Math.Clamp(value, min, max);
        public static int Clamp(int value, int min, int max) => Math.Clamp(value, min, max);
        public static float Clamp01(float value) => value < 0f ? 0f : value > 1f ? 1f : value;
        public static float Lerp(float a, float b, float t) => a + (b - a) * Clamp01(t);
        public static float InverseLerp(float a, float b, float value) => 0f;
        public static float Round(float f) => (float)Math.Round(f);
        public static int RoundToInt(float f) => (int)Math.Round(f);
        public static float Floor(float f) => (float)Math.Floor(f);
        public static int FloorToInt(float f) => (int)Math.Floor(f);
        public static float Ceil(float f) => (float)Math.Ceiling(f);
        public static int CeilToInt(float f) => (int)Math.Ceiling(f);
        public static float Sqrt(float f) => (float)Math.Sqrt(f);
        public static float Pow(float f, float p) => (float)Math.Pow(f, p);
        public static float Sin(float f) => (float)Math.Sin(f);
        public static float Cos(float f) => (float)Math.Cos(f);
        public static float Atan2(float y, float x) => (float)Math.Atan2(y, x);
        public static int Sign(float f) => f >= 0f ? 1 : -1;
        public static float Sign(float f, float unused) => f;
        public static bool Approximately(float a, float b) => Math.Abs(b - a) < 1e-5f;
        public static float MoveTowards(float current, float target, float maxDelta) => target;
        public static float SmoothStep(float from, float to, float t) => to;
        public static float Repeat(float t, float length) => t;
        public static float PingPong(float t, float length) => t;
        public static float PerlinNoise(float x, float y) => 0f;
    }

    public static class Time
    {
        public static float time => 0f;
        public static float timeSinceLevelLoad => 0f;
        public static float deltaTime => 0f;
        public static float fixedDeltaTime => 0f;
        public static float unscaledTime => 0f;
        public static float unscaledDeltaTime => 0f;
        public static float realtimeSinceStartup => 0f;
        public static float smoothDeltaTime => 0f;
        public static float maximumDeltaTime => 0f;
        public static float timeScale { get; set; }
        public static int frameCount => 0;
        public static int renderedFrameCount => 0;
        public static double realtimeSinceStartupAsDouble => 0d;
        public static double timeAsDouble => 0d;
    }

    public static class Screen
    {
        public static int width => 1920;
        public static int height => 1080;
        public static float dpi => 96f;
        public static bool fullScreen { get; set; }
        public static float dpiScale => 1f;
        public static int currentResolution_width => 1920;
        public static Resolution[] resolutions => Array.Empty<Resolution>();
        public static void SetResolution(int width, int height, bool fullscreen) { }
    }

    public struct Resolution
    {
        public int width;
        public int height;
        public int refreshRate;
    }

    public static class Application
    {
        public static string unityVersion => "2022.3.62f2";
        public static string productName => "Sultan's Game";
        public static string companyName => "Double Cross";
        public static string version => "1.0.0";
        public static string identifier => "com.doublecross.sultan";
        public static string dataPath => AppDomain.CurrentDomain.BaseDirectory;
        public static string persistentDataPath => System.IO.Path.GetTempPath();
        public static string streamingAssetsPath => AppDomain.CurrentDomain.BaseDirectory;
        public static string temporaryCachePath => System.IO.Path.GetTempPath();
        public static string consoleLogPath => string.Empty;
        public static bool isPlaying => true;
        public static bool isEditor => false;
        public static bool isFocused => true;
        public static int targetFrameRate { get; set; }
        public static RuntimePlatform platform => RuntimePlatform.WindowsPlayer;
        public static SystemLanguage systemLanguage => SystemLanguage.ChineseSimplified;
        public static bool runInBackground { get; set; }
        public static string[] arguments => Array.Empty<string>();

        public static event Action quitting;
        public static event Action<bool> focusChanged;

        public static void Quit() { }
        public static void Quit(int exitCode) { }
        public static void OpenURL(string url) { }
        public static void logMessageReceivedHandler(string condition, string stackTrace, LogType type) { }
    }

    public enum RuntimePlatform { WindowsPlayer = 2, WindowsEditor = 7 }
    public enum SystemLanguage { ChineseSimplified = 40, English = 10 }

    public static class Debug
    {
        public static bool isDebugBuild => false;
        public static bool developerConsoleVisible { get; set; }

        public static void Log(object message) { }
        public static void Log(object message, Object context) { }
        public static void LogFormat(string format, params object[] args) { }
        public static void LogWarning(object message) { }
        public static void LogWarning(object message, Object context) { }
        public static void LogWarningFormat(string format, params object[] args) { }
        public static void LogError(object message) { }
        public static void LogError(object message, Object context) { }
        public static void LogErrorFormat(string format, params object[] args) { }
        public static void LogException(Exception exception) { }
        public static void LogException(Exception exception, Object context) { }
        public static void Assert(bool condition) { }
        public static void DrawLine(Vector3 start, Vector3 end) { }
        public static void DrawLine(Vector3 start, Vector3 end, Color color) { }
        public static void Break() { }
    }

    public enum LogType { Error, Assert, Warning, Log, Exception }

    public static class Resources
    {
        public static T Load<T>(string path) where T : Object => null;
        public static Object Load(string path) => null;
        public static Object Load(string path, Type systemTypeInstance) => null;
        public static T[] LoadAll<T>(string path) where T : Object => Array.Empty<T>();
        public static T GetBuiltinResource<T>(string path) where T : Object => null;
        public static Object GetBuiltinResource(Type type, string path) => null;
        public static T[] FindObjectsOfTypeAll<T>() where T : Object => Array.Empty<T>();
        public static Object[] FindObjectsOfTypeAll(Type type) => Array.Empty<Object>();
        public static void UnloadAsset(Object assetToUnload) { }
        public static AsyncOperation UnloadUnusedAssets() => null;
    }

    public class AsyncOperation : YieldInstruction
    {
        public AsyncOperation(IntPtr pointer) : base(pointer)
        {
        }

        public bool isDone => true;
        public float progress => 1f;
        public bool allowSceneActivation { get; set; }
        public int priority { get; set; }
        public event Action<AsyncOperation> completed;
    }

    public static class SystemInfo
    {
        public static string unityVersion => Application.unityVersion;
        public static string deviceName => "PC";
        public static string operatingSystem => Environment.OSVersion.ToString();
        public static string processorType => "x86_64";
        public static int processorCount => Environment.ProcessorCount;
        public static int systemMemorySize => 16384;
        public static int graphicsMemorySize => 8192;
        public static string graphicsDeviceName => "GPU";
        public static bool supportsComputeShaders => true;
    }

    public static class PlayerPrefs
    {
        public static void SetInt(string key, int value) { }
        public static int GetInt(string key, int defaultValue = 0) => defaultValue;
        public static void SetString(string key, string value) { }
        public static string GetString(string key, string defaultValue = "") => defaultValue;
        public static void SetFloat(string key, float value) { }
        public static float GetFloat(string key, float defaultValue = 0f) => defaultValue;
        public static bool HasKey(string key) => false;
        public static void DeleteKey(string key) { }
        public static void DeleteAll() { }
        public static void Save() { }
    }

    public class Texture : Object
    {
        protected Texture(IntPtr pointer) : base(pointer)
        {
        }

        public int width { get; set; }
        public int height { get; set; }
        public FilterMode filterMode { get; set; }
        public TextureWrapMode wrapMode { get; set; }
        public int anisoLevel { get; set; }
    }

    public class Texture2D : Texture
    {
        public Texture2D(int width, int height) : base(IntPtr.Zero)
        {
            this.width = width;
            this.height = height;
        }

        public Texture2D(int width, int height, TextureFormat format, bool mipChain) : this(width, height) { }

        public TextureFormat format => TextureFormat.RGBA32;
        public bool isReadable => false;

        public void SetPixel(int x, int y, Color color) { }
        public void SetPixels(Color[] colors) { }
        public Color GetPixel(int x, int y) => default;
        public void Apply() { }
        public void Apply(bool updateMipmaps) { }
        public static Texture2D whiteTexture => null;
        public static Texture2D blackTexture => null;
    }

    public enum TextureFormat { Alpha8 = 1, RGB24 = 3, RGBA32 = 4, ARGB32 = 5, BGRA32 = 14 }
    public enum FilterMode { Point, Bilinear, Trilinear }
    public enum TextureWrapMode { Repeat, Clamp, Mirror, MirrorOnce }

    public class Sprite : Object
    {
        protected Sprite(IntPtr pointer) : base(pointer)
        {
        }

        public static Sprite Create(Texture2D texture, Rect rect, Vector2 pivot) => null;
        public Rect rect => default;
        public Texture2D texture => null;
    }

    public class Font : Object
    {
        protected Font(IntPtr pointer) : base(pointer)
        {
        }

        public int fontSize { get; set; }
        public bool dynamic => true;
        public static Font CreateDynamicFontFromOSFont(string fontname, int size) => null;
        public static string[] GetOSInstalledFontNames() => Array.Empty<string>();
        public static Font GetDefault() => null;
    }

    public enum FontStyle { Normal, Bold, Italic, BoldAndItalic }
    public enum TextAnchor
    {
        UpperLeft, UpperCenter, UpperRight,
        MiddleLeft, MiddleCenter, MiddleRight,
        LowerLeft, LowerCenter, LowerRight
    }

    public enum TextClipping { Overflow, Clip }
    public enum ScaleMode { StretchToFill, ScaleAndCrop, ScaleToFit }
    public enum ImagePosition { ImageLeft, ImageAbove, ImageOnly, TextOnly }

    public sealed class RectOffset : Object
    {
        public RectOffset() : base(IntPtr.Zero) { }
        public RectOffset(int left, int right, int top, int bottom) : base(IntPtr.Zero)
        {
            this.left = left;
            this.right = right;
            this.top = top;
            this.bottom = bottom;
        }

        public int left { get; set; }
        public int right { get; set; }
        public int top { get; set; }
        public int bottom { get; set; }
        public int horizontal => left + right;
        public int vertical => top + bottom;
    }

    public sealed class GUIContent
    {
        public GUIContent() { }
        public GUIContent(string text) { this.text = text; }
        public GUIContent(Texture image) { this.image = image; }
        public GUIContent(string text, Texture image) { this.text = text; this.image = image; }

        public string text { get; set; }
        public Texture image { get; set; }
        public string tooltip { get; set; }
        public static GUIContent none => new GUIContent();
    }

    public sealed class GUIStyleState
    {
        public Texture2D background { get; set; }
        public Color textColor { get; set; }
    }

    public sealed class GUIStyle
    {
        public GUIStyle() { }
        public GUIStyle(GUIStyle other) { }

        public string name { get; set; }
        public GUIStyleState normal { get; set; } = new GUIStyleState();
        public GUIStyleState hover { get; set; } = new GUIStyleState();
        public GUIStyleState active { get; set; } = new GUIStyleState();
        public GUIStyleState focused { get; set; } = new GUIStyleState();
        public GUIStyleState onNormal { get; set; } = new GUIStyleState();
        public GUIStyleState onHover { get; set; } = new GUIStyleState();
        public GUIStyleState onActive { get; set; } = new GUIStyleState();
        public RectOffset border { get; set; } = new RectOffset();
        public RectOffset margin { get; set; } = new RectOffset();
        public RectOffset padding { get; set; } = new RectOffset();
        public RectOffset overflow { get; set; } = new RectOffset();
        public TextAnchor alignment { get; set; }
        public FontStyle fontStyle { get; set; }
        public bool wordWrap { get; set; }
        public bool richText { get; set; }
        public TextClipping clipping { get; set; }
        public int fontSize { get; set; }
        public Font font { get; set; }
        public float fixedWidth { get; set; }
        public float fixedHeight { get; set; }
        public bool stretchWidth { get; set; }
        public bool stretchHeight { get; set; }
        public ImagePosition imagePosition { get; set; }
        public int lineHeight => 16;

        public Vector2 CalcSize(GUIContent content) => default;
        public float CalcHeight(GUIContent content, float width) => 0f;
        public void Draw(Rect position, GUIContent content, int controlID) { }
    }

    public sealed class GUISkin : Object
    {
        public GUISkin(IntPtr pointer) : base(pointer)
        {
        }

        public GUIStyle box { get; set; }
        public GUIStyle label { get; set; }
        public GUIStyle button { get; set; }
        public GUIStyle textArea { get; set; }
        public GUIStyle textField { get; set; }
        public GUIStyle window { get; set; }
        public GUIStyle toggle { get; set; }
        public GUIStyle scrollView { get; set; }
        public Font font { get; set; }
        public GUIStyle GetStyle(string styleName) => new GUIStyle();
    }

    public sealed class GUILayoutOption
    {
    }

    public class GUI
    {
        public static Color color { get; set; }
        public static Color backgroundColor { get; set; }
        public static Color contentColor { get; set; }
        public static int depth { get; set; }
        public static GUISkin skin { get; set; }
        public static bool enabled { get; set; }

        public static void Box(Rect position, string text) { }
        public static void Box(Rect position, string text, GUIStyle style) { }
        public static void Box(Rect position, GUIContent content) { }
        public static void Box(Rect position, GUIContent content, GUIStyle style) { }
        public static void Box(Rect position, Texture image) { }
        public static void Box(Rect position, Texture image, GUIStyle style) { }

        public static void Label(Rect position, string text) { }
        public static void Label(Rect position, string text, GUIStyle style) { }
        public static void Label(Rect position, GUIContent content) { }
        public static void Label(Rect position, GUIContent content, GUIStyle style) { }
        public static void Label(Rect position, Texture image) { }
        public static void Label(Rect position, Texture image, GUIStyle style) { }

        public static bool Button(Rect position, string text) => false;
        public static bool Button(Rect position, string text, GUIStyle style) => false;
        public static bool Button(Rect position, GUIContent content) => false;
        public static bool Button(Rect position, GUIContent content, GUIStyle style) => false;
        public static bool RepeatButton(Rect position, string text) => false;

        public static string TextField(Rect position, string text) => text;
        public static string TextField(Rect position, string text, GUIStyle style) => text;
        public static string TextArea(Rect position, string text) => text;

        public static bool Toggle(Rect position, bool value, string text) => value;
        public static float HorizontalSlider(Rect position, float value, float leftValue, float rightValue) => value;

        public static void DrawTexture(Rect position, Texture image) { }
        public static void DrawTexture(Rect position, Texture image, ScaleMode scaleMode) { }
        public static void BeginGroup(Rect position) { }
        public static void EndGroup() { }
        public static Vector2 BeginScrollView(Rect position, Vector2 scrollPosition, Rect viewRect) => scrollPosition;
        public static void EndScrollView() { }
        public static void SetNextControlName(string name) { }
        public static string GetNameOfFocusedControl() => string.Empty;
        public static void FocusControl(string name) { }
        public static void DragWindow() { }
        public static void DragWindow(Rect position) { }
    }

    public class GUILayout
    {
        public static void Label(string text, params GUILayoutOption[] options) { }
        public static void Label(string text, GUIStyle style, params GUILayoutOption[] options) { }
        public static bool Button(string text, params GUILayoutOption[] options) => false;
        public static bool Button(string text, GUIStyle style, params GUILayoutOption[] options) => false;
        public static void Box(string text, params GUILayoutOption[] options) { }
        public static string TextField(string text, params GUILayoutOption[] options) => text;
        public static bool Toggle(bool value, string text, params GUILayoutOption[] options) => value;
        public static void Space(float pixels) { }
        public static void FlexibleSpace() { }
        public static void BeginHorizontal(params GUILayoutOption[] options) { }
        public static void EndHorizontal() { }
        public static void BeginVertical(params GUILayoutOption[] options) { }
        public static void EndVertical() { }
        public static void BeginArea(Rect screenRect) { }
        public static void EndArea() { }
        public static Vector2 BeginScrollView(Vector2 scrollPosition, params GUILayoutOption[] options)
            => scrollPosition;
        public static void EndScrollView() { }
        public static GUILayoutOption Width(float width) => null;
        public static GUILayoutOption Height(float height) => null;
        public static GUILayoutOption MinWidth(float minWidth) => null;
        public static GUILayoutOption MaxWidth(float maxWidth) => null;
        public static GUILayoutOption ExpandWidth(bool expand) => null;
        public static GUILayoutOption ExpandHeight(bool expand) => null;
    }

    public class WaitForSecondsRealtime : YieldInstruction
    {
        public WaitForSecondsRealtime(float time) : base(IntPtr.Zero) { }
    }

    public static class Random
    {
        public static float value => 0.5f;
        public static int Range(int minInclusive, int maxExclusive) => minInclusive;
        public static float Range(float minInclusive, float maxInclusive) => minInclusive;
        public static void InitState(int seed) { }
    }

    public static class JsonUtility
    {
        public static string ToJson(object obj) => "{}";
        public static string ToJson(object obj, bool prettyPrint) => "{}";
        public static T FromJson<T>(string json) => default;
        public static void FromJsonOverwrite(string json, object objectToOverwrite) { }
    }

    public static class QualitySettings
    {
        public static int vSyncCount { get; set; }
        public static int antiAliasing { get; set; }
        public static string[] names => Array.Empty<string>();
    }
}

namespace UnityEngine.EventSystems
{
    // A namespace only exists in metadata if it declares a type.
    public static class EventSystemsStub
    {
    }
}

namespace UnityEngine.UI
{
    public static class UiStub
    {
    }
}

namespace UnityEngine.Events
{
    public delegate void UnityAction();
    public delegate void UnityAction<T0>(T0 arg0);
    public delegate void UnityAction<T0, T1>(T0 arg0, T1 arg1);
    public delegate void UnityAction<T0, T1, T2>(T0 arg0, T1 arg1, T2 arg2);
    public delegate void UnityAction<T0, T1, T2, T3>(T0 arg0, T1 arg1, T2 arg2, T3 arg3);

    public abstract class UnityEventBase
    {
        public int GetPersistentEventCount() => 0;
        public string GetPersistentMethodName(int index) => string.Empty;
        public void RemoveAllListeners() { }
    }

    public class UnityEvent : UnityEventBase
    {
        public void AddListener(UnityAction call) { }
        public void RemoveListener(UnityAction call) { }
        public void Invoke() { }
    }

    public class UnityEvent<T0> : UnityEventBase
    {
        public void AddListener(UnityAction<T0> call) { }
        public void RemoveListener(UnityAction<T0> call) { }
        public void Invoke(T0 arg0) { }
    }

    public class UnityEvent<T0, T1> : UnityEventBase
    {
        public void AddListener(UnityAction<T0, T1> call) { }
        public void RemoveListener(UnityAction<T0, T1> call) { }
        public void Invoke(T0 arg0, T1 arg1) { }
    }
}

namespace UnityEngine.SceneManagement
{
    public struct Scene
    {
        public string name => string.Empty;
        public string path => string.Empty;
        public int buildIndex => 0;
        public bool isLoaded => false;
        public bool isDirty => false;
        public int rootCount => 0;
        public bool IsValid() => false;
        public GameObject[] GetRootGameObjects() => Array.Empty<GameObject>();
        public static bool operator ==(Scene lhs, Scene rhs) => true;
        public static bool operator !=(Scene lhs, Scene rhs) => false;
        public override bool Equals(object other) => other is Scene;
        public override int GetHashCode() => 0;
    }

    public enum LoadSceneMode { Single, Additive }
    public enum UnloadSceneOptions { None, UnloadAllEmbeddedSceneObjects }

    public class SceneManager
    {
        public static int sceneCount => 1;
        public static int sceneCountInBuildSettings => 1;

        public static event UnityEngine.Events.UnityAction<Scene, LoadSceneMode> sceneLoaded;
        public static event UnityEngine.Events.UnityAction<Scene> sceneUnloaded;
        public static event UnityEngine.Events.UnityAction<Scene, Scene> activeSceneChanged;

        public static Scene GetActiveScene() => default;
        public static bool SetActiveScene(Scene scene) => true;
        public static Scene GetSceneAt(int index) => default;
        public static Scene GetSceneByName(string name) => default;
        public static Scene GetSceneByPath(string scenePath) => default;
        public static Scene GetSceneByBuildIndex(int buildIndex) => default;
        public static void LoadScene(string sceneName) { }
        public static void LoadScene(string sceneName, LoadSceneMode mode) { }
        public static void LoadScene(int sceneBuildIndex) { }
        public static AsyncOperation LoadSceneAsync(string sceneName) => null;
        public static AsyncOperation LoadSceneAsync(string sceneName, LoadSceneMode mode) => null;
        public static AsyncOperation UnloadSceneAsync(Scene scene) => null;
        public static void CreateScene(string sceneName) { }
        public static void MergeScenes(Scene sourceScene, Scene destinationScene) { }
        public static void MoveGameObjectToScene(GameObject go, Scene scene) { }
    }
}
