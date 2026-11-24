//! The COM side: a class factory Explorer asks for by `CLSID`, and the thumbnail provider it
//! makes, which Explorer gives the file as a stream and then asks for a bitmap of a given size.

use std::{
    cell::RefCell,
    ffi::c_void,
    io::{self, Read, Seek, SeekFrom},
    panic::{catch_unwind, AssertUnwindSafe},
    ptr::null_mut,
    sync::atomic::{AtomicIsize, AtomicUsize, Ordering},
};

use windows::{
    core::{implement, Interface, Ref, Result, GUID, HRESULT},
    Win32::{
        Foundation::{
            CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, E_FAIL, E_POINTER, E_UNEXPECTED,
            S_FALSE, S_OK,
        },
        Graphics::Gdi::{
            CreateDIBSection, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
        },
        System::Com::{
            IClassFactory, IClassFactory_Impl, IStream, STREAM_SEEK_CUR, STREAM_SEEK_END,
            STREAM_SEEK_SET,
        },
        UI::Shell::{
            IThumbnailProvider, IThumbnailProvider_Impl,
            PropertiesSystem::{IInitializeWithStream, IInitializeWithStream_Impl},
            WTSAT_RGB, WTS_ALPHATYPE,
        },
    },
};
use windows_core::BOOL;

/// The thumbnail handler's class, as the installer registers it.
pub const CLSID: GUID = GUID::from_u128(0x926c88c4_506e_429b_808f_17c2be6eea16);

/// Objects alive and locks held; Windows unloads the DLL only when both are zero.
static OBJECTS: AtomicUsize = AtomicUsize::new(0);
static LOCKS: AtomicIsize = AtomicIsize::new(0);

struct Alive;

impl Alive {
    fn new() -> Self {
        OBJECTS.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for Alive {
    fn drop(&mut self) {
        OBJECTS.fetch_sub(1, Ordering::SeqCst);
    }
}

#[implement(IClassFactory)]
struct Factory {
    _alive: Alive,
}

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<'_, windows_core::IUnknown>,
        iid: *const GUID,
        object: *mut *mut c_void,
    ) -> Result<()> {
        if object.is_null() || iid.is_null() {
            return Err(E_POINTER.into());
        }
        // SAFETY: COM passes a writable out pointer, checked above.
        unsafe { *object = null_mut() };
        if !outer.is_null() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        let provider: IThumbnailProvider = Provider {
            stream: RefCell::new(None),
            _alive: Alive::new(),
        }
        .into();
        // SAFETY: both pointers were checked; `query` writes the interface or null.
        unsafe { provider.query(iid, object) }.ok()
    }

    fn LockServer(&self, lock: BOOL) -> Result<()> {
        if lock.as_bool() {
            LOCKS.fetch_add(1, Ordering::SeqCst);
        } else {
            LOCKS.fetch_sub(1, Ordering::SeqCst);
        }
        Ok(())
    }
}

#[implement(IInitializeWithStream, IThumbnailProvider)]
struct Provider {
    stream: RefCell<Option<IStream>>,
    _alive: Alive,
}

impl IInitializeWithStream_Impl for Provider_Impl {
    fn Initialize(&self, stream: Ref<'_, IStream>, _mode: u32) -> Result<()> {
        let stream = stream.ok()?;
        let mut current = self.stream.borrow_mut();
        if current.is_some() {
            return Err(E_UNEXPECTED.into());
        }
        *current = Some(stream.clone());
        Ok(())
    }
}

impl IThumbnailProvider_Impl for Provider_Impl {
    fn GetThumbnail(
        &self,
        size: u32,
        bitmap: *mut HBITMAP,
        alpha: *mut WTS_ALPHATYPE,
    ) -> Result<()> {
        if bitmap.is_null() || alpha.is_null() {
            return Err(E_POINTER.into());
        }
        let stream = self.stream.borrow().clone().ok_or(E_UNEXPECTED)?;
        // A book that breaks the reader gets no thumbnail; the panic stays in this DLL.
        let thumbnail = catch_unwind(AssertUnwindSafe(|| {
            let mut source = StreamReader(&stream);
            source.seek(SeekFrom::Start(0)).ok()?;
            crate::cover_thumbnail(source, size)
        }))
        .ok()
        .flatten()
        .ok_or(E_FAIL)?;
        let made = to_bitmap(&thumbnail)?;
        // SAFETY: both out pointers were checked above.
        unsafe {
            *bitmap = made;
            *alpha = WTSAT_RGB;
        }
        Ok(())
    }
}

/// A 32-bit top-down DIB section holding the thumbnail, which the caller then owns.
fn to_bitmap(thumbnail: &crate::Thumbnail) -> Result<HBITMAP> {
    let width = i32::try_from(thumbnail.width).map_err(|_| E_FAIL)?;
    let height = i32::try_from(thumbnail.height).map_err(|_| E_FAIL)?;
    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits: *mut c_void = null_mut();
    // SAFETY: `info` describes a 32-bit DIB; Windows allocates its pixels and returns them.
    let bitmap = unsafe { CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0) }?;
    if bits.is_null() {
        return Err(E_FAIL.into());
    }
    let count = thumbnail.pixels.len() / 3;
    // SAFETY: the DIB holds `width * height` 32-bit pixels, one for each RGB triple.
    let target = unsafe { std::slice::from_raw_parts_mut(bits.cast::<u8>(), count * 4) };
    for (to, [r, g, b]) in target
        .as_chunks_mut::<4>()
        .0
        .iter_mut()
        .zip(thumbnail.pixels.as_chunks::<3>().0)
    {
        *to = [*b, *g, *r, 255];
    }
    Ok(bitmap)
}

/// The stream Explorer hands over, read as a file.
struct StreamReader<'a>(&'a IStream);

impl Read for StreamReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let wanted = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
        let mut read = 0u32;
        // SAFETY: `buffer` has room for `wanted` bytes.
        unsafe {
            self.0
                .Read(buffer.as_mut_ptr().cast(), wanted, Some(&mut read))
        }
        .ok()
        .map_err(io::Error::other)?;
        Ok(read as usize)
    }
}

impl Seek for StreamReader<'_> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let (offset, origin) = match position {
            SeekFrom::Start(offset) => (
                i64::try_from(offset).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?,
                STREAM_SEEK_SET,
            ),
            SeekFrom::End(offset) => (offset, STREAM_SEEK_END),
            SeekFrom::Current(offset) => (offset, STREAM_SEEK_CUR),
        };
        let mut now = 0u64;
        // SAFETY: `now` receives the new position.
        unsafe { self.0.Seek(offset, origin, Some(&mut now)) }.map_err(io::Error::other)?;
        Ok(now)
    }
}

/// Hands Explorer the class factory for `CLSID`.
///
/// # Safety
///
/// `class` and `iid` must point to GUIDs and `object` to writable storage for an interface
/// pointer, as COM guarantees.
#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(
    class: *const GUID,
    iid: *const GUID,
    object: *mut *mut c_void,
) -> HRESULT {
    if class.is_null() || iid.is_null() || object.is_null() {
        return E_POINTER;
    }
    // SAFETY: the pointers were checked; the caller guarantees what they point to.
    unsafe {
        *object = null_mut();
        if *class != CLSID {
            return CLASS_E_CLASSNOTAVAILABLE;
        }
        let factory: IClassFactory = Factory {
            _alive: Alive::new(),
        }
        .into();
        factory.query(iid, object)
    }
}

/// Whether Windows may unload the DLL: no object it made is alive and no lock is held.
#[no_mangle]
pub extern "system" fn DllCanUnloadNow() -> HRESULT {
    if OBJECTS.load(Ordering::SeqCst) == 0 && LOCKS.load(Ordering::SeqCst) <= 0 {
        S_OK
    } else {
        S_FALSE
    }
}
