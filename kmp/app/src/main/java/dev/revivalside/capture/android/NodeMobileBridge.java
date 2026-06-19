package dev.revivalside.capture.android;

public final class NodeMobileBridge {
    private static boolean loaded;
    private static Throwable loadError;

    static {
        try {
            System.loadLibrary("node");
            System.loadLibrary("revivalside_node_bridge");
            loaded = true;
        } catch (Throwable error) {
            loadError = error;
            loaded = false;
        }
    }

    private NodeMobileBridge() {
    }

    public static boolean isLoaded() {
        return loaded;
    }

    public static String loadErrorMessage() {
        return loadError == null ? "" : loadError.toString();
    }

    public static native int startNodeWithArguments(String[] arguments);
}
