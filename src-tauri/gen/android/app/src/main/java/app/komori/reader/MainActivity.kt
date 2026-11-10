package app.komori.reader

import android.content.Context
import android.media.AudioManager
import android.os.Bundle
import android.view.ActionMode
import android.view.KeyEvent
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

private val pageKeys = setOf(
  KeyEvent.KEYCODE_PAGE_UP,
  KeyEvent.KEYCODE_PAGE_DOWN,
  KeyEvent.KEYCODE_DPAD_UP,
  KeyEvent.KEYCODE_DPAD_DOWN,
  KeyEvent.KEYCODE_DPAD_LEFT,
  KeyEvent.KEYCODE_DPAD_RIGHT,
  KeyEvent.KEYCODE_SPACE,
)

class MainActivity : TauriActivity() {
  private var page: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    page = webView
  }

  /**
   * The volume keys ask the page first: the Reader takes them to turn the page when its
   * setting is on. Any press it leaves changes the volume, as it does without Komori.
   */
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val key = when (event.keyCode) {
      KeyEvent.KEYCODE_VOLUME_UP -> "up"
      KeyEvent.KEYCODE_VOLUME_DOWN -> "down"
      else -> null
    }
    val view = page
    // An e-reader's page buttons and a page turner send page and arrow keys. The page has
    // them only while it has focus, which it lacks until something is touched.
    if (key == null && view != null && event.keyCode in pageKeys && !view.hasFocus())
      view.requestFocusFromTouch()
    if (key == null || view == null) return super.dispatchKeyEvent(event)
    if (event.action == KeyEvent.ACTION_DOWN) {
      view.evaluateJavascript("window.komoriVolumeKey?.('$key') === true") { taken ->
        if (taken == "true") return@evaluateJavascript
        val audio = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        audio.adjustSuggestedStreamVolume(
          if (key == "up") AudioManager.ADJUST_RAISE else AudioManager.ADJUST_LOWER,
          AudioManager.USE_DEFAULT_STREAM_TYPE,
          AudioManager.FLAG_SHOW_UI,
        )
      }
    }
    return true
  }

  /**
   * The book's selection shows Komori's toolbar, so Android's floating one is replaced by a
   * mode that shows nothing. Text fields and other text keep Android's.
   */
  override fun onWindowStartingActionMode(callback: ActionMode.Callback, type: Int): ActionMode? {
    if (type != ActionMode.TYPE_FLOATING || !BookSelection.own || currentFocus?.onCheckIsTextEditor() == true)
      return super.onWindowStartingActionMode(callback, type)
    val mode = QuietActionMode(this, callback)
    return if (callback.onCreateActionMode(mode, mode.menu)) mode else null
  }
}
