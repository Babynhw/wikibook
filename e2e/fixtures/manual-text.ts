/**
 * The pasted-text source (PRD §5.3) for the §21 walk, and the notes the walk
 * writes by hand. Every fact is fictional and distinct from the PDF and the
 * article so a scoped question has exactly one source that can answer it.
 */
export const MANUAL_SOURCE = {
  title: 'Marlow Harbour Ferry Timetable Notes',
  author: 'Harbour Office',
  body: [
    'The Marlow harbour ferry crosses between the fish quay and Sandy Point every forty minutes from six in the morning until nine at night, with a reduced hourly service on Sundays.',
    'The ferry is the motor launch Kittiwake, licensed for thirty-two passengers and four bicycles. She was built in 1979 and re-engined in 2008.',
    'Crossings are suspended when the ebb race off the headland exceeds three knots, which the harbour office announces on channel twelve. A shore shuttle runs instead.',
    'Fares are collected on board. A single crossing costs two pounds fifty and a ten-crossing card costs twenty pounds.',
  ].join('\n\n'),
};

/** A note whose fact appears in no source, so its converted snapshot is the only thing that can answer it. */
export const CONVERTIBLE_NOTE = {
  title: 'Field note: the Kittiwake bell',
  content:
    'The Kittiwake carries a brass bell cast in Dunmore in 1979 that is rung exactly three times before every departure from the fish quay. The crew call it the Pellworth bell after the ferry\'s first skipper.',
};

/** Questions. The spec asserts shape, never wording, so these only need to be answerable. */
export const QUESTIONS = {
  aboutManualSource: 'How often does the harbour ferry run, and what is the launch called?',
  acrossSpace: 'When was the Marlow Lighthouse completed and how tall is it?',
  offTopic: 'What is the recommended tyre pressure for a 1998 Volvo estate on gravel roads?',
  aboutConvertedNote: 'How many times is the Kittiwake bell rung before departure, and what do the crew call it?',
};
