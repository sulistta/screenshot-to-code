import { renderHook, act } from "@testing-library/react";
import { useImageAttachments, MAX_ATTACHMENTS } from "./useImageAttachments";

const imageFile = (name: string) => new File([`bytes-${name}`], name, { type: "image/png" });
const textFile = (name: string) => new File([`bytes-${name}`], name, { type: "text/plain" });

const flushReads = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
};

describe("useImageAttachments", () => {
  beforeEach(() => sessionStorage.clear());

  it("accepts images and reports non-images instead of skipping silently", async () => {
    const { result } = renderHook(() => useImageAttachments());
    act(() => {
      result.current.addFiles([imageFile("a.png"), textFile("notes.txt")]);
    });
    expect(result.current.attachError).toMatch(/not an image/);
    await flushReads();
    expect(result.current.images).toHaveLength(1);
  });

  it(`enforces the limit of ${MAX_ATTACHMENTS} images`, async () => {
    const { result } = renderHook(() => useImageAttachments());
    act(() => {
      result.current.addFiles([1, 2, 3, 4, 5, 6].map((n) => imageFile(`${n}.png`)));
    });
    await flushReads();
    expect(result.current.images).toHaveLength(MAX_ATTACHMENTS);
    expect(result.current.attachError).toMatch(/At most/);
    act(() => {
      result.current.addFiles([imageFile("extra.png")]);
    });
    await flushReads();
    expect(result.current.images).toHaveLength(MAX_ATTACHMENTS);
  });

  it("removes attachments and surfaces unreadable files", async () => {
    const { result } = renderHook(() => useImageAttachments());
    act(() => {
      result.current.addFiles([imageFile("a.png")]);
    });
    await flushReads();
    expect(result.current.images).toHaveLength(1);
    act(() => {
      result.current.removeAt(0);
    });
    expect(result.current.images).toHaveLength(0);

    const readSpy = jest.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
      this.onerror?.call(this, new ProgressEvent("error") as ProgressEvent<FileReader>);
    });
    try {
      act(() => {
        result.current.addFiles([imageFile("bad.png")]);
      });
      expect(result.current.attachError).toMatch(/Could not read/);
      expect(result.current.images).toHaveLength(0);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("persists attachments per storage key", async () => {
    const { result, unmount } = renderHook(() => useImageAttachments("attachments:p9"));
    act(() => {
      result.current.addFiles([imageFile("a.png")]);
    });
    await flushReads();
    unmount();
    const { result: second } = renderHook(() => useImageAttachments("attachments:p9"));
    expect(second.current.images).toHaveLength(1);
    const { result: other } = renderHook(() => useImageAttachments("attachments:other"));
    expect(other.current.images).toHaveLength(0);
  });
});
