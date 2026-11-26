package io.github.terminatooooooor.shoh;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

/**
 * «Поделиться» → Shoh: текст из приложения chess.com (ссылка на партию или PGN)
 * передаётся в веб-часть через window.__shohShare(text).
 * При холодном старте страница ещё грузится, поэтому пробуем несколько раз,
 * пока функция не появится.
 */
public class MainActivity extends BridgeActivity {
    private static final int MAX_TRIES = 40;
    private final Handler handler = new Handler(Looper.getMainLooper());

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        handleShare(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleShare(intent);
    }

    private void handleShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        if (text == null) return;
        if (subject != null && !text.contains(subject)) text = subject + " " + text;
        deliver(JSONObject.quote(text), 0);
    }

    private void deliver(final String quoted, final int attempt) {
        if (attempt >= MAX_TRIES || getBridge() == null) return;
        WebView web = getBridge().getWebView();
        if (web == null) {
            handler.postDelayed(() -> deliver(quoted, attempt + 1), 250);
            return;
        }
        String js = "(typeof window.__shohShare === 'function') ? window.__shohShare(" + quoted + ") : false";
        web.evaluateJavascript(js, result -> {
            if (!"true".equals(result)) handler.postDelayed(() -> deliver(quoted, attempt + 1), 250);
        });
    }
}
