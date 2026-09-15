// DAOWOW PATCH (vendored bytes 1.12.1): CKB-VM scripts are single-threaded
// and the base CKB-VM ISA has no RISC-V A-extension instructions, so all
// atomic operations are replaced with plain reads/writes. Ordering hints are
// accepted and ignored. DO NOT use the patched crate in multi-threaded code.

#[cfg(all(not(all(test, loom)), daowow_noatomic))]
pub(crate) mod sync {
    pub(crate) mod atomic {
        use core::cell::UnsafeCell;

        #[derive(Default)]
        pub(crate) struct AtomicUsize(UnsafeCell<usize>);
        impl AtomicUsize {
            pub(crate) const fn new(v: usize) -> Self {
                AtomicUsize(UnsafeCell::new(v))
            }
            #[allow(unused_variables)]
            pub(crate) fn load(&self, order: Ordering) -> usize {
                unsafe { *self.0.get() }
            }
            #[allow(unused_variables)]
            pub(crate) fn fetch_add(&self, v: usize, order: Ordering) -> usize {
                unsafe {
                    let p = self.0.get();
                    let old = *p;
                    *p = old.wrapping_add(v);
                    old
                }
            }
            #[allow(unused_variables)]
            pub(crate) fn fetch_sub(&self, v: usize, order: Ordering) -> usize {
                unsafe {
                    let p = self.0.get();
                    let old = *p;
                    *p = old.wrapping_sub(v);
                    old
                }
            }
            #[allow(unused_variables)]
            pub(crate) fn compare_exchange(
                &self,
                current: usize,
                new: usize,
                success: Ordering,
                failure: Ordering,
            ) -> Result<usize, usize> {
                unsafe {
                    let p = self.0.get();
                    let old = *p;
                    if old == current {
                        *p = new;
                        Ok(old)
                    } else {
                        Err(old)
                    }
                }
            }
        }

        #[derive(Default)]
        pub(crate) struct AtomicPtr<T>(UnsafeCell<*mut T>);
        impl<T> AtomicPtr<T> {
            pub(crate) const fn new(p: *mut T) -> Self {
                AtomicPtr(UnsafeCell::new(p))
            }
            #[allow(unused_variables)]
            pub(crate) fn load(&self, order: Ordering) -> *mut T {
                unsafe { *self.0.get() }
            }
            #[allow(unused_variables)]
            pub(crate) fn compare_exchange(
                &self,
                current: *mut T,
                new: *mut T,
                success: Ordering,
                failure: Ordering,
            ) -> Result<*mut T, *mut T> {
                unsafe {
                    let p = self.0.get();
                    let old = *p;
                    if old == current {
                        *p = new;
                        Ok(old)
                    } else {
                        Err(old)
                    }
                }
            }
        }

        pub(crate) trait AtomicMut<T> {
            fn with_mut<F, R>(&mut self, f: F) -> R
            where
                F: FnOnce(&mut *mut T) -> R;
        }

        impl<T> AtomicMut<T> for AtomicPtr<T> {
            fn with_mut<F, R>(&mut self, f: F) -> R
            where
                F: FnOnce(&mut *mut T) -> R,
            {
                unsafe { f(&mut *self.0.get()) }
            }
        }

        #[derive(Copy, Clone, Debug, PartialEq, Eq)]
        pub(crate) enum Ordering {
            Relaxed,
            Acquire,
            Release,
            AcqRel,
        }
    }
}

#[cfg(all(not(all(test, loom)), not(daowow_noatomic)))]
pub(crate) mod sync {
    pub(crate) mod atomic {
        #[cfg(not(feature = "extra-platforms"))]
        pub(crate) use core::sync::atomic::{AtomicPtr, AtomicUsize, Ordering};
        #[cfg(feature = "extra-platforms")]
        pub(crate) use extra_platforms::{AtomicPtr, AtomicUsize, Ordering};

        pub(crate) trait AtomicMut<T> {
            fn with_mut<F, R>(&mut self, f: F) -> R
            where
                F: FnOnce(&mut *mut T) -> R;
        }

        impl<T> AtomicMut<T> for AtomicPtr<T> {
            fn with_mut<F, R>(&mut self, f: F) -> R
            where
                F: FnOnce(&mut *mut T) -> R,
            {
                f(self.get_mut())
            }
        }
    }
}

#[cfg(all(test, loom))]
pub(crate) mod sync {
    pub(crate) mod atomic {
        pub(crate) use loom::sync::atomic::{AtomicPtr, AtomicUsize, Ordering};

        pub(crate) trait AtomicMut<T> {}
    }
}
