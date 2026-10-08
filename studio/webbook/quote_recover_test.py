import unittest,runpy
from pathlib import Path
candidate=runpy.run_path(str(Path(__file__).with_name('quote-recover.py')))['candidates']
class Quotes(unittest.TestCase):
 def test_only_empty_pairs_in_same_segment(self):
  def t(text,x,segment):return {'text':text,'segment':segment,'position':{'x':x}}
  r={'lines':[t('“',0,0),t('”',1,0),t('“',2,1),t('l',3,1),t('”',4,1),t('“',5,2),t('”',6,3)]}
  self.assertEqual(len(list(candidate(r))),1)
if __name__=='__main__':unittest.main()
