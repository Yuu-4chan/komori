package app.komori.reader

import android.os.Bundle
import android.view.ActionMode
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
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
