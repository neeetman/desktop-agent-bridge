import unittest,tempfile,pathlib,json,os,time,zipfile
from maintenance import plan,archive
class RetentionTest(unittest.TestCase):
 def test_only_old_terminal_generated_files_are_archived(self):
  with tempfile.TemporaryDirectory(prefix='bridge-retention-') as directory:
   root=pathlib.Path(directory);runtime=root/'runtime';runtime.mkdir();identifier='12345678-1234-1234-1234-123456789012'
   f=runtime/f'guide-{identifier}.md';f.write_text('unique protocol evidence');os.utime(f,(time.time()-9*86400,)*2)
   state={'tasks':{identifier:{'status':'running','threadId':'chat'}}};(runtime/'state.json').write_text(json.dumps(state));self.assertEqual(plan(runtime),[])
   state['tasks'][identifier]['status']='completed';(runtime/'state.json').write_text(json.dumps(state));items=plan(runtime);self.assertEqual(len(items),1)
   result=archive(runtime,root/'archive',items);self.assertEqual(result['removed'],1);self.assertFalse(f.exists())
   with zipfile.ZipFile(result['archive']) as z:self.assertEqual(z.read(f.name),b'unique protocol evidence')
 def test_protected_unknown_and_fixed_guides_are_retained(self):
  with tempfile.TemporaryDirectory(prefix='bridge-retention-') as directory:
   runtime=pathlib.Path(directory);(runtime/'router').mkdir();identifier='12345678-1234-1234-1234-123456789012'
   (runtime/'router/protected-threads.json').write_text(json.dumps({'threadIds':['L1']}));(runtime/'state.json').write_text(json.dumps({'tasks':{identifier:{'status':'completed','threadId':'L1'}}}))
   for name in [f'guide-{identifier}.md','guide-v2.md','user-report.md']:
    f=runtime/name;f.write_text('keep');os.utime(f,(time.time()-9*86400,)*2)
   self.assertEqual(plan(runtime),[])
if __name__=='__main__':unittest.main()
