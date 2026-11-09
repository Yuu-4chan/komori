package app.komori.reader

import android.content.Context
import android.view.ActionMode
import android.view.Menu
import android.view.MenuInflater
import android.view.View
import android.widget.PopupMenu

/**
 * Whether a selection made now is the book's: Komori shows its own toolbar for it, so
 * Android's stays hidden. The Reader sets it as a finger touches the book or anything else.
 */
object BookSelection {
  @Volatile var own = false
}

/**
 * An action mode that shows nothing. The WebView keeps its selection and handles while one is
 * started, and finishes it when the selection is cleared, as it does Android's toolbar.
 */
class QuietActionMode(context: Context, private val callback: ActionMode.Callback) : ActionMode() {
  private val actions = PopupMenu(context, View(context)).menu
  private val inflater = MenuInflater(context)
  private var title: CharSequence? = null
  private var subtitle: CharSequence? = null
  private var custom: View? = null
  private var finished = false

  init {
    type = TYPE_FLOATING
  }

  override fun setTitle(title: CharSequence?) {
    this.title = title
  }

  override fun setTitle(resId: Int) {}

  override fun setSubtitle(subtitle: CharSequence?) {
    this.subtitle = subtitle
  }

  override fun setSubtitle(resId: Int) {}

  override fun setCustomView(view: View?) {
    custom = view
  }

  override fun invalidate() {
    if (!finished) callback.onPrepareActionMode(this, actions)
  }

  override fun finish() {
    if (finished) return
    finished = true
    callback.onDestroyActionMode(this)
  }

  override fun getMenu(): Menu = actions

  override fun getTitle(): CharSequence? = title

  override fun getSubtitle(): CharSequence? = subtitle

  override fun getCustomView(): View? = custom

  override fun getMenuInflater(): MenuInflater = inflater
}
