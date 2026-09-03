import Link from 'next/link'

export default function NotFound(): React.ReactElement {
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">Not here</span>
      </div>
      <div className="panel-body">
        <p className="plain" style={{ marginTop: 0 }}>
          That page or case does not exist in this batch. Case ids change every time the batch is
          reseeded, so a bookmarked link will not survive a new run.
        </p>
        <Link href="/cases" className="chip" style={{ display: 'inline-block' }}>
          Back to cases
        </Link>
      </div>
    </div>
  )
}
