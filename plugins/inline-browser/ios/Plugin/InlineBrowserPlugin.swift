import Foundation
import Capacitor
import WebKit

/**
 * WKWebView inline intégré à l'onglet Site (iOS).
 *
 * Pourquoi : tr4ker.net envoie X-Frame-Options / CSP qui interdisent
 * l'iframe, et @capgo/inappbrowser n'ouvre qu'une modale plein écran
 * par-dessus l'app. Ce plugin ajoute une vraie WKWebView top-level
 * (donc autorisée par le serveur) comme sous-vue positionnée sur le
 * rectangle du conteneur HTML de l'onglet.
 *
 * Session : WKWebsiteDataStore.default() = cookies TR4KER conservés.
 * Interception : le JS injecté depuis l'app (INTERCEPTOR_WKWEBVIEW_JS)
 * poste via window.webkit.messageHandlers.tr4kerBridge -> event
 * "browserMessage". Filets natifs : magnet: annulé + notifié
 * (event "urlChange"), réponse .torrent annulée + notifiée.
 */
@objc(InlineBrowserPlugin)
public class InlineBrowserPlugin: CAPPlugin, CAPBridgedPlugin, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    public let identifier = "InlineBrowserPlugin"
    public let jsName = "InlineBrowser"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "goBack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "goForward", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "executeScript", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise)
    ]

    private var inlineWebView: WKWebView?
    private static let handlerName = "tr4kerBridge"

    private func state(of wv: WKWebView) -> JSObject {
        return [
            "url": wv.url?.absoluteString ?? "",
            "canGoBack": wv.canGoBack,
            "canGoForward": wv.canGoForward
        ]
    }

    private func rect(from call: CAPPluginCall) -> CGRect {
        let x = call.getDouble("x") ?? 0
        let y = call.getDouble("y") ?? 0
        let w = call.getDouble("width") ?? 0
        let h = call.getDouble("height") ?? 0
        // Points iOS == pixels CSS : pas de conversion d'échelle.
        return CGRect(x: x, y: y, width: max(w, 0), height: max(h, 0))
    }

    private func closeWebView() {
        if let wv = inlineWebView {
            wv.navigationDelegate = nil
            wv.uiDelegate = nil
            wv.configuration.userContentController.removeScriptMessageHandler(forName: Self.handlerName)
            wv.removeFromSuperview()
        }
        inlineWebView = nil
    }

    @objc func open(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("InlineBrowser.open: url manquante")
            return
        }
        let rect = self.rect(from: call)
        DispatchQueue.main.async {
            self.closeWebView()
            let config = WKWebViewConfiguration()
            config.websiteDataStore = WKWebsiteDataStore.default()
            config.allowsInlineMediaPlayback = true
            config.userContentController.add(self, name: Self.handlerName)
            let wv = WKWebView(frame: rect, configuration: config)
            wv.navigationDelegate = self
            wv.uiDelegate = self
            wv.allowsBackForwardNavigationGestures = true
            self.inlineWebView = wv
            self.bridge?.viewController?.view.addSubview(wv)
            wv.load(URLRequest(url: url))
            call.resolve()
        }
    }

    @objc func setRect(_ call: CAPPluginCall) {
        let rect = self.rect(from: call)
        DispatchQueue.main.async {
            self.inlineWebView?.frame = rect
            call.resolve()
        }
    }

    @objc func loadUrl(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("InlineBrowser.loadUrl: url manquante")
            return
        }
        DispatchQueue.main.async {
            self.inlineWebView?.load(URLRequest(url: url))
            call.resolve()
        }
    }

    @objc func goBack(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let wv = self.inlineWebView, wv.canGoBack {
                wv.goBack()
                call.resolve(self.state(of: wv))
            } else if let wv = self.inlineWebView {
                call.resolve(self.state(of: wv))
            } else {
                call.reject("InlineBrowser: pas de vue ouverte")
            }
        }
    }

    @objc func goForward(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let wv = self.inlineWebView, wv.canGoForward {
                wv.goForward()
                call.resolve(self.state(of: wv))
            } else if let wv = self.inlineWebView {
                call.resolve(self.state(of: wv))
            } else {
                call.reject("InlineBrowser: pas de vue ouverte")
            }
        }
    }

    @objc func reload(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.inlineWebView?.reload()
            call.resolve()
        }
    }

    @objc func executeScript(_ call: CAPPluginCall) {
        guard let code = call.getString("code") else {
            call.reject("InlineBrowser.executeScript: code manquant")
            return
        }
        DispatchQueue.main.async {
            self.inlineWebView?.evaluateJavaScript(code) { _, error in
                if let error = error {
                    call.reject("InlineBrowser.executeScript: \(error.localizedDescription)")
                } else {
                    call.resolve()
                }
            }
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.closeWebView()
            call.resolve()
        }
    }

    // MARK: - WKNavigationDelegate

    public func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        let raw = url.absoluteString
        if raw.lowercased().hasPrefix("magnet:") {
            // Non affichable : on annule et on laisse l'app l'envoyer à Transmission.
            decisionHandler(.cancel)
            notifyListeners("urlChange", data: ["url": raw, "navigation": "magnet"])
            return
        }
        decisionHandler(.allow)
    }

    public func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let url = navigationResponse.response.url?.absoluteString ?? ""
        let mime = ((navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type")
            ?? navigationResponse.response.mimeType ?? "").lowercased()
        if Self.isTorrentUrl(url) && (mime.contains("bittorrent") || mime.contains("octet-stream")) {
            // Téléchargement direct : l'intercepteur JS n'a pas pu le capter,
            // l'app retentera en fetch (event urlChange).
            decisionHandler(.cancel)
            notifyListeners("urlChange", data: ["url": url, "navigation": "torrent"])
            return
        }
        decisionHandler(.allow)
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        notifyListeners("load", data: state(of: webView))
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        notifyListeners("load", data: state(of: webView))
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled {
            return
        }
        var s = state(of: webView)
        s["error"] = error.localizedDescription
        notifyListeners("load", data: s)
    }

    // MARK: - WKUIDelegate (target=_blank / window.open : reste dans la vue inline)

    public func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            webView.load(URLRequest(url: url))
        }
        return nil
    }

    // MARK: - WKScriptMessageHandler (pont window.webkit.messageHandlers.tr4kerBridge)

    public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.handlerName else { return }
        if let dict = message.body as? [String: Any] {
            notifyListeners("browserMessage", data: dict)
        } else if let str = message.body as? String {
            notifyListeners("browserMessage", data: ["type": "string", "value": str])
        }
    }

    private static func isTorrentUrl(_ href: String) -> Bool {
        let l = href.lowercased()
        return l.contains(".torrent")
            || (l.contains("/api/torrents/") && l.contains("/download"))
            || (l.contains("/download") && l.contains("torrent"))
    }
}
