package net.tr4ker.inlinebrowser;

import android.annotation.SuppressLint;
import android.graphics.Bitmap;
import android.net.http.SslError;
import android.os.Build;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;

/**
 * WebView inline intégrée à l'onglet Site (Android).
 *
 * Pendant iOS de InlineBrowserPlugin.swift : une vraie WebView top-level
 * (donc autorisée par tr4ker.net malgré X-Frame-Options / CSP) ajoutée comme
 * sous-vue positionnée sur le rectangle du conteneur HTML de l'onglet,
 * au lieu d'une modale plein écran par-dessus l'app.
 *
 * Pont JS : le même intercepteur que sur iOS poste via
 * window.webkit.messageHandlers.tr4kerBridge.postMessage(detail).
 * Un shim injecté avant l'intercepteur redirige cet appel vers
 * l'interface JavascriptInterface window.tr4kerBridge.
 */
@CapacitorPlugin(name = "InlineBrowser")
public class InlineBrowserPlugin extends Plugin {

    private static final String TAG = "InlineBrowser";
    private static final String EVENT_MESSAGE = "browserMessage";
    private static final String EVENT_URL_CHANGE = "urlChange";
    private static final String EVENT_LOAD = "load";

    /** Shim : expose le même pont webkit que sur iOS par-dessus l'interface Android. */
    private static final String WEBKIT_SHIM =
        "(function(){try{if(window.tr4kerBridge&&(!window.webkit||!window.webkit.messageHandlers||!window.webkit.messageHandlers.tr4kerBridge)){window.webkit=window.webkit||{};window.webkit.messageHandlers=window.webkit.messageHandlers||{};window.webkit.messageHandlers.tr4kerBridge={postMessage:function(d){try{window.tr4kerBridge.postMessage(typeof d==='string'?d:JSON.stringify(d));}catch(e){}}};}}catch(e){}})();";

    private static final String STORAGE_DUMP_JS =
        "(function(){function d(s){var o={};try{for(var i=0;i<s.length;i++){var k=s.key(i);try{o[k]=s.getItem(k);}catch(e){}}}catch(e){}return o;}try{return JSON.stringify({local:d(window.localStorage),session:d(window.sessionStorage)});}catch(e){return \"\";}})();";

    private WebView inlineWebView;
    private String injectScript = "";

    private class Tr4kerBridge {
        @JavascriptInterface
        public void postMessage(String message) {
            try {
                if (message == null || message.isEmpty()) return;
                JSObject data = jsonToJSObject(message);
                notifyListeners(EVENT_MESSAGE, data);
            } catch (Exception e) {
                Log.e(TAG, "postMessage failed: " + e.getMessage());
            }
        }
    }

    private static JSObject jsonToJSObject(String json) {
        JSObject out = new JSObject();
        try {
            JSONObject o = new JSONObject(json);
            Iterator<String> keys = o.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                try {
                    out.put(k, o.opt(k));
                } catch (Exception ignored) {}
            }
        } catch (Exception e) {
            try {
                out.put("value", json);
            } catch (Exception ignored) {}
        }
        return out;
    }

    private JSObject stateOf(WebView wv) {
        JSObject s = new JSObject();
        try {
            s.put("url", wv.getUrl() != null ? wv.getUrl() : "");
            s.put("canGoBack", wv.canGoBack());
            s.put("canGoForward", wv.canGoForward());
        } catch (Exception ignored) {}
        return s;
    }

    private static boolean isTorrentUrl(String href) {
        if (href == null) return false;
        String l = href.toLowerCase();
        return l.contains(".torrent")
            || (l.contains("/api/torrents/") && l.contains("/download"))
            || (l.contains("/download") && l.contains("torrent"));
    }

    private int dp(double cssPx) {
        float density = getContext().getResources().getDisplayMetrics().density;
        return (int) Math.round(cssPx * density);
    }

    @SuppressLint({ "SetJavaScriptEnabled", "AddJavascriptInterface" })
    private WebView createWebView(String inject) {
        WebView wv = new WebView(getContext());
        WebSettings settings = wv.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            cm.setAcceptThirdPartyCookies(wv, true);
        }

        wv.addJavascriptInterface(new Tr4kerBridge(), "tr4kerBridge");

        wv.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl() != null ? request.getUrl().toString() : "";
                if (url.toLowerCase().startsWith("magnet:")) {
                    JSObject data = new JSObject();
                    try {
                        data.put("url", url);
                        data.put("navigation", "magnet");
                    } catch (Exception ignored) {}
                    notifyListeners(EVENT_URL_CHANGE, data);
                    return true;
                }
                return false;
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url != null && url.toLowerCase().startsWith("magnet:")) {
                    JSObject data = new JSObject();
                    try {
                        data.put("url", url);
                        data.put("navigation", "magnet");
                    } catch (Exception ignored) {}
                    notifyListeners(EVENT_URL_CHANGE, data);
                    return true;
                }
                return false;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                // Shim tôt : l'intercepteur stocké s'appuie dessus.
                try {
                    view.evaluateJavascript(WEBKIT_SHIM, null);
                } catch (Exception ignored) {}
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                Log.i(TAG, "pageFinished url=" + url + " title=" + view.getTitle()
                    + " visible=" + (view.getVisibility() == View.VISIBLE)
                    + " size=" + view.getWidth() + "x" + view.getHeight());
                try {
                    view.evaluateJavascript(WEBKIT_SHIM, null);
                } catch (Exception ignored) {}
                if (injectScript != null && !injectScript.isEmpty()) {
                    try {
                        view.evaluateJavascript(injectScript, null);
                    } catch (Exception ignored) {}
                }
                notifyListeners(EVENT_LOAD, stateOf(view));
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                try {
                    Log.e(TAG, "pageError url=" + (request != null && request.getUrl() != null ? request.getUrl().toString() : "?")
                        + " main=" + (request != null && request.isForMainFrame())
                        + " code=" + (error != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? error.getErrorCode() : -1));
                } catch (Exception ignored) {}
                if (request != null && request.isForMainFrame()) {
                    JSObject s = stateOf(view);
                    try {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && error != null) {
                            s.put("error", String.valueOf(error.getDescription()));
                        } else {
                            s.put("error", "load error");
                        }
                    } catch (Exception ignored) {}
                    notifyListeners(EVENT_LOAD, s);
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
            }
        });

        wv.setWebChromeClient(new WebChromeClient());

        wv.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimeType, long contentLength) {
                String mime = mimeType != null ? mimeType.toLowerCase() : "";
                boolean torrentMime = mime.contains("bittorrent") || mime.contains("octet-stream");
                if (isTorrentUrl(url) || torrentMime) {
                    downloadTorrentBytes(url);
                } else {
                    // URL .torrent servie avec un mime banal : on laisse l'app retenter.
                    JSObject data = new JSObject();
                    try {
                        data.put("url", url);
                        data.put("navigation", "torrent");
                    } catch (Exception ignored) {}
                    notifyListeners(EVENT_URL_CHANGE, data);
                }
            }
        });

        return wv;
    }

    /** Télécharge un .torrent avec les cookies de la WebView puis poste les octets en base64. */
    private void downloadTorrentBytes(String url) {
        final String pageUrl;
        try {
            pageUrl = inlineWebView != null && inlineWebView.getUrl() != null ? inlineWebView.getUrl() : "";
        } catch (Exception e) {
            return;
        }
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                URL u = new URL(url);
                conn = (HttpURLConnection) u.openConnection();
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(30000);
                conn.setRequestProperty("Accept", "application/x-bittorrent,*/*");
                String cookies = CookieManager.getInstance().getCookie(url);
                if (cookies != null && !cookies.isEmpty()) {
                    conn.setRequestProperty("Cookie", cookies);
                }
                conn.connect();
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) return;
                String filename = "download.torrent";
                String disp = conn.getHeaderField("Content-Disposition");
                if (disp != null && disp.contains("filename=")) {
                    try {
                        filename = disp.split("filename=")[1].replace("\"", "").trim();
                    } catch (Exception ignored) {}
                } else {
                    try {
                        String base = url.split("\\?")[0];
                        String last = base.substring(base.lastIndexOf('/') + 1);
                        if (!last.isEmpty()) {
                            filename = last.toLowerCase().endsWith(".torrent") ? last : last + ".torrent";
                        }
                    } catch (Exception ignored) {}
                }
                InputStream in = conn.getInputStream();
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                long total = 0;
                while ((n = in.read(buf)) != -1) {
                    total += n;
                    if (total > 100_000_000) return;
                    out.write(buf, 0, n);
                }
                byte[] bytes = out.toByteArray();
                if (bytes.length == 0) return;
                String b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP);
                JSObject data = new JSObject();
                data.put("type", "tr4ker-torrent-bytes");
                data.put("bytesBase64", b64);
                data.put("filename", filename);
                data.put("sourceURL", url);
                data.put("pageURL", pageUrl);
                notifyListeners(EVENT_MESSAGE, data);
            } catch (Exception e) {
                Log.e(TAG, "torrent download failed: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    private void applyRect(int x, int y, int w, int h) {
        WebView wv = inlineWebView;
        if (wv == null) {
            Log.i(TAG, "applyRect: no view (x=" + x + " y=" + y + " w=" + w + " h=" + h + ")");
            return;
        }
        if (w < 10 || h < 10) {
            Log.i(TAG, "applyRect: hide (x=" + x + " y=" + y + " w=" + w + " h=" + h + ")");
            wv.setVisibility(View.GONE);
            return;
        }
        wv.setVisibility(View.VISIBLE);
        wv.bringToFront();
        try {
            ViewGroup parent = (ViewGroup) wv.getParent();
            if (parent == null) return;
            ViewGroup.LayoutParams lp = wv.getLayoutParams();
            int px = dp(x);
            int py = dp(y);
            int pw = dp(w);
            int ph = dp(h);
            Log.i(TAG, "applyRect css=(" + x + "," + y + "," + w + "," + h + ") px=(" + px + "," + py + "," + pw + "," + ph
                + ") parent=" + parent.getClass().getName() + " lp=" + (lp != null ? lp.getClass().getName() : "null"));
            if (lp instanceof FrameLayout.LayoutParams) {
                FrameLayout.LayoutParams fl = (FrameLayout.LayoutParams) lp;
                fl.width = pw;
                fl.height = ph;
                fl.leftMargin = px;
                fl.topMargin = py;
                fl.gravity = android.view.Gravity.TOP | android.view.Gravity.START;
                wv.setLayoutParams(fl);
            } else if (lp instanceof ViewGroup.MarginLayoutParams) {
                ViewGroup.MarginLayoutParams ml = (ViewGroup.MarginLayoutParams) lp;
                ml.width = pw;
                ml.height = ph;
                ml.leftMargin = px;
                ml.topMargin = py;
                wv.setLayoutParams(ml);
            } else {
                wv.setX(px);
                wv.setY(py);
                lp.width = pw;
                lp.height = ph;
                wv.setLayoutParams(lp);
            }
            wv.requestLayout();
        } catch (Exception e) {
            Log.e(TAG, "setRect failed: " + e.getMessage());
        }
    }

    private void destroyWebView() {
        if (inlineWebView != null) {
            try {
                ViewGroup parent = (ViewGroup) inlineWebView.getParent();
                if (parent != null) parent.removeView(inlineWebView);
                inlineWebView.stopLoading();
                inlineWebView.destroy();
            } catch (Exception ignored) {}
            inlineWebView = null;
        }
        injectScript = "";
    }

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("InlineBrowser.open: url manquante");
            return;
        }
        final int x = call.getInt("x", 0);
        final int y = call.getInt("y", 0);
        final int w = call.getInt("width", 0);
        final int h = call.getInt("height", 0);
        final String inject = call.getString("injectScript", "");
        Log.i(TAG, "open url=" + url + " rect=(" + x + "," + y + "," + w + "," + h + ")");

        getActivity().runOnUiThread(() -> {
            try {
                destroyWebView();
                injectScript = inject != null ? inject : "";
                inlineWebView = createWebView(injectScript);
                inlineWebView.setVisibility(View.VISIBLE);
                ViewGroup parent;
                try {
                    parent = (ViewGroup) bridge.getWebView().getParent();
                } catch (Exception e) {
                    parent = null;
                }
                if (parent == null) {
                    parent = getActivity().findViewById(android.R.id.content);
                }
                Log.i(TAG, "open parent=" + (parent != null ? parent.getClass().getName() : "null")
                    + " capView=" + bridge.getWebView().getWidth() + "x" + bridge.getWebView().getHeight());
                FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(dp(Math.max(w, 0)), dp(Math.max(h, 0)));
                lp.leftMargin = dp(x);
                lp.topMargin = dp(y);
                lp.gravity = android.view.Gravity.TOP | android.view.Gravity.START;
                parent.addView(inlineWebView, lp);
                inlineWebView.bringToFront();
                parent.requestLayout();
                parent.invalidate();
                applyRect(x, y, w, h);
                inlineWebView.loadUrl(url);
                call.resolve();
            } catch (Exception e) {
                call.reject("InlineBrowser.open: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void setRect(PluginCall call) {
        final int x = call.getInt("x", 0);
        final int y = call.getInt("y", 0);
        final int w = call.getInt("width", 0);
        final int h = call.getInt("height", 0);
        getActivity().runOnUiThread(() -> {
            applyRect(x, y, w, h);
            call.resolve();
        });
    }

    @PluginMethod
    public void loadUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("InlineBrowser.loadUrl: url manquante");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (inlineWebView != null) inlineWebView.loadUrl(url);
            call.resolve();
        });
    }

    @PluginMethod
    public void goBack(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (inlineWebView == null) {
                call.reject("InlineBrowser: pas de vue ouverte");
                return;
            }
            if (inlineWebView.canGoBack()) inlineWebView.goBack();
            call.resolve(stateOf(inlineWebView));
        });
    }

    @PluginMethod
    public void goForward(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (inlineWebView == null) {
                call.reject("InlineBrowser: pas de vue ouverte");
                return;
            }
            if (inlineWebView.canGoForward()) inlineWebView.goForward();
            call.resolve(stateOf(inlineWebView));
        });
    }

    @PluginMethod
    public void reload(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (inlineWebView != null) inlineWebView.reload();
            call.resolve();
        });
    }

    @PluginMethod
    public void executeScript(PluginCall call) {
        String code = call.getString("code");
        if (code == null) {
            call.reject("InlineBrowser.executeScript: code manquant");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (inlineWebView == null) {
                call.reject("InlineBrowser: pas de vue ouverte");
                return;
            }
            try {
                inlineWebView.evaluateJavascript(code, null);
                call.resolve();
            } catch (Exception e) {
                call.reject("InlineBrowser.executeScript: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void readStorage(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (inlineWebView == null) {
                JSObject ret = new JSObject();
                try {
                    ret.put("json", "");
                } catch (Exception ignored) {}
                call.resolve(ret);
                return;
            }
            try {
                inlineWebView.evaluateJavascript(STORAGE_DUMP_JS, new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        JSObject ret = new JSObject();
                        try {
                            String inner = "";
                            if (value != null && !value.equals("null") && value.length() >= 2) {
                                try {
                                    Object v = new org.json.JSONTokener(value).nextValue();
                                    if (v instanceof String) inner = (String) v;
                                } catch (Exception ignored) {}
                            }
                            ret.put("json", inner);
                        } catch (Exception ignored) {}
                        call.resolve(ret);
                    }
                });
            } catch (Exception e) {
                JSObject ret = new JSObject();
                try {
                    ret.put("json", "");
                } catch (Exception ignored) {}
                call.resolve(ret);
            }
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            destroyWebView();
            call.resolve();
        });
    }

    @PluginMethod
    public void log(PluginCall call) {
        String level = call.getString("level", "info");
        String tag = call.getString("tag", "Web");
        String message = call.getString("message", "");
        Log.i(TAG, "[" + level + "] " + tag + " " + message);
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        try {
            if (getActivity() != null) {
                getActivity().runOnUiThread(this::destroyWebView);
            } else {
                destroyWebView();
            }
        } catch (Exception ignored) {}
    }
}
