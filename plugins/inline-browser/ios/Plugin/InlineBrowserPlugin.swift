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
        CAPPluginMethod(name: "readStorage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "log", returnType: CAPPluginReturnPromise)
    ]

    private var inlineWebView: WKWebView?
    private static let handlerName = "tr4kerBridge"
    private static let cookieBackupKey = "InlineBrowser.sessionCookies"
    /// Téléchargements directs en cours (référence forte jusqu'à finish/fail).
    private var activeDownloads: [WKDownload] = []
    /// Destination de chaque téléchargement (WKDownload non Hashable).
    private var downloadDestinations: [ObjectIdentifier: URL] = [:]

    override public func load() {
        NotificationCenter.default.addObserver(
            self, selector: #selector(handleDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func handleDidEnterBackground() {
        backupSessionCookies()
    }

    /// Archive les cookies de session TR4KER (non persistés par WKWebView
    /// au kill : TR4KER_session est sessionOnly). Valeurs jamais exposées au JS.
    private func backupSessionCookies() {
        let store = WKWebsiteDataStore.default().httpCookieStore
        store.getAllCookies { cookies in
            let session = cookies.filter { $0.domain.contains("tr4ker.net") && $0.isSessionOnly }
            guard !session.isEmpty else { return }
            do {
                let data = try NSKeyedArchiver.archivedData(withRootObject: session, requiringSecureCoding: false)
                UserDefaults.standard.set(data, forKey: Self.cookieBackupKey)
            } catch {
                /* ignore */
            }
        }
    }

    /// Restaure les cookies de session AVANT le premier chargement.
    private func restoreSessionCookies(completion: @escaping () -> Void) {
        guard let data = UserDefaults.standard.data(forKey: Self.cookieBackupKey) else {
            completion()
            return
        }
        var saved: [HTTPCookie] = []
        do {
            if let arr = try NSKeyedUnarchiver.unarchiveTopLevelObjectWithData(data) as? [HTTPCookie] {
                saved = arr.filter { $0.expiresDate == nil || $0.expiresDate! > Date() }
            }
        } catch {
            /* ignore */
        }
        guard !saved.isEmpty else {
            completion()
            return
        }
        let store = WKWebsiteDataStore.default().httpCookieStore
        let group = DispatchGroup()
        for c in saved {
            group.enter()
            store.setCookie(c) { group.leave() }
        }
        group.notify(queue: .main) {
            completion()
        }
    }

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
        let inject = call.getString("injectScript") ?? ""
        DispatchQueue.main.async {
            self.closeWebView()
            // Restaure d'abord la session (cookies) puis charge : la page
            // arrive déjà connectée après un kill/relance.
            self.restoreSessionCookies {
                let config = WKWebViewConfiguration()
                config.websiteDataStore = WKWebsiteDataStore.default()
                config.allowsInlineMediaPlayback = true
                config.userContentController.add(self, name: Self.handlerName)
                if !inject.isEmpty {
                    // Injection auto (main + sous-frames, fin de document) :
                    // les pièges sont armés avant tout clic possible, sans
                    // dépendre d'une réinjection après chaque chargement.
                    let script = WKUserScript(source: inject, injectionTime: .atDocumentEnd, forMainFrameOnly: false)
                    config.userContentController.addUserScript(script)
                }
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

    /// Relaye un log JS vers NSLog : visible dans la console Xcode
    /// (les console.log de la WKWebView n'y arrivent pas tout seuls).
    @objc func log(_ call: CAPPluginCall) {
        let level = (call.getString("level") ?? "info").uppercased()
        let tag = call.getString("tag") ?? "Web"
        let message = call.getString("message") ?? ""
        NSLog("[%@] %@ %@", level, tag, message)
        call.resolve()
    }

    /// Dump JSON {local, session} des storages de la page (sauvetage de la
    /// session TR4KER entre deux lancements : le sessionStorage ne survit
    /// pas au kill, contrairement aux cookies).
    @objc func readStorage(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            // Sauvegarde aussi les cookies de session au passage (mêmes
            // déclencheurs côté TS : intervalle, masquage, mise en fond).
            self.backupSessionCookies()
            guard let wv = self.inlineWebView else {
                call.resolve(["json": ""])
                return
            }
            let code = "(function(){function d(s){var o={};try{for(var i=0;i<s.length;i++){var k=s.key(i);try{o[k]=s.getItem(k);}catch(e){}}}catch(e){}return o;}try{return JSON.stringify({local:d(window.localStorage),session:d(window.sessionStorage)});}catch(e){return \"\";}})();"
            wv.evaluateJavaScript(code) { result, error in
                if error != nil {
                    call.resolve(["json": ""])
                } else {
                    call.resolve(["json": result as? String ?? ""])
                }
            }
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
        let isBlob = url.lowercased().hasPrefix("blob:")
        if (Self.isTorrentUrl(url) || isBlob) && (mime.contains("bittorrent") || mime.contains("octet-stream")) {
            // Téléchargement direct consommé via WKDownload : les octets sont
            // lus depuis la réponse live (insensible au CSP connect-src, à la
            // révocation du blob et aux cookies). La page ne bouge pas.
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    public func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
        activeDownloads.append(download)
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
        // Seules les vraies erreurs réseau (DNS, hors-ligne, TLS...) sont
        // signalées : les interruptions de politique (nos propres annulations
        // blob:/torrent, déjà traitées via urlChange/refetch) sont du bruit.
        guard ns.domain == (NSURLErrorDomain as String) else {
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

    private func forgetDownload(_ download: WKDownload) {
        activeDownloads.removeAll { $0 === download }
        downloadDestinations.removeValue(forKey: ObjectIdentifier(download))
    }
}

// MARK: - Téléchargements directs (la page ne bouge pas, la fiche dossier s'ouvre)

extension InlineBrowserPlugin: WKDownloadDelegate {
    public func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let base = suggestedFilename.isEmpty ? UUID().uuidString + ".torrent" : suggestedFilename
        let dest = FileManager.default.temporaryDirectory.appendingPathComponent("tr4ker-" + base)
        downloadDestinations[ObjectIdentifier(download)] = dest
        completionHandler(dest)
    }

    public func download(_ download: WKDownload, didReceive response: URLResponse, completionHandler: @escaping (Bool) -> Void) {
        // Garde anti-abus : on ne télécharge que du torrent.
        let mime = (response.mimeType ?? "").lowercased()
        completionHandler(mime.contains("bittorrent") || mime.contains("octet-stream"))
    }

    public func downloadDidFinish(_ download: WKDownload) {
        let id = ObjectIdentifier(download)
        let fileURL = downloadDestinations[id]
        forgetDownload(download)
        guard let fileURL = fileURL else {
            return
        }
        do {
            let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
            let size = (attrs[.size] as? NSNumber)?.intValue ?? 0
            guard size > 0 && size < 100_000_000 else {
                try? FileManager.default.removeItem(at: fileURL)
                return
            }
            let data = try Data(contentsOf: fileURL)
            try? FileManager.default.removeItem(at: fileURL)
            let pageURL = self.inlineWebView?.url?.absoluteString ?? ""
            var name = fileURL.lastPathComponent
            if name.hasPrefix("tr4ker-") { name = String(name.dropFirst(7)) }
            if name.isEmpty { name = "download.torrent" }
            notifyListeners("browserMessage", data: [
                "type": "tr4ker-torrent-bytes",
                "bytesBase64": data.base64EncodedString(),
                "filename": name,
                "sourceURL": pageURL,
                "pageURL": pageURL,
            ] as [String: Any])
        } catch {
            try? FileManager.default.removeItem(at: fileURL)
        }
    }

    public func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        forgetDownload(download)
    }
}
