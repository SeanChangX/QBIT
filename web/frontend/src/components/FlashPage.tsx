export default function FlashPage() {
  return (
    <div className="flash-page">
      <iframe
        className="flash-iframe"
        src="https://seanchangx.github.io/QBIT/"
        title="QBIT Firmware Flasher"
        allow="serial"
      />
    </div>
  );
}
